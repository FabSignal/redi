**Correcto, está enfocado en USDC pero trabajaste con XLM. Aquí está la versión corregida y consistente:**

---

# DeFindex Vault Creation Guide - XLM Implementation

**Target Audience:** Developers integrating DeFindex XLM yield vaults into Stellar/Soroban applications  
**Prerequisites:** Basic understanding of Stellar blockchain, testnet funded wallet, curl/jq installed

---

## Table of Contents

1. [Understanding DeFindex Architecture](#1-understanding-defindex-architecture)
2. [Prerequisites & Setup](#2-prerequisites--setup)
3. [Authentication Process](#3-authentication-process)
4. [Asset & Strategy Discovery](#4-asset--strategy-discovery)
5. [Vault Creation with XLM](#5-vault-creation-with-xlm)
6. [Transaction Signing & Submission](#6-transaction-signing--submission)
7. [Vault Verification](#7-vault-verification)
8. [Buffer Contract Integration](#8-buffer-contract-integration)
9. [Troubleshooting](#9-troubleshooting)

---

## 1. Understanding DeFindex Architecture

### What is DeFindex?

DeFindex is a decentralized vault protocol on Stellar that automatically deploys user assets into yield-generating strategies. Think of it as a programmable asset manager that routes capital to optimized DeFi positions.

### Key Concepts

**Vault:** A Soroban smart contract that holds user deposits and manages strategy allocations. Each vault can support multiple assets and strategies.

**Strategy:** A specific DeFi protocol integration (e.g., Blend lending, Soroswap liquidity pools) where the vault deploys capital to earn yield.

**Asset:** A Stellar Asset Contract (SAC) that the vault accepts for deposits. In this guide, we use **native XLM**.

**Shares:** When you deposit into a vault, you receive vault shares representing your proportional ownership. Share value appreciates as strategies generate yield.

### Network-Specific Contract Addresses

**CRITICAL:** Contract addresses differ completely between testnet and mainnet. Always verify you're using the correct network.

| Network     | Purpose               | Contracts Repository     |
| ----------- | --------------------- | ------------------------ |
| **Testnet** | Development & testing | `testnet.contracts.json` |
| **Mainnet** | Production            | `mainnet.contracts.json` |

### Architecture Flow

```
User Deposit (XLM)
        ↓
Buffer Contract (your app layer)
        ↓
DeFindex Vault Contract
        ↓
Strategy Selection (Blend)
        ↓
Yield Generation
        ↓
Share Value Appreciation
        ↓
User Withdrawal (XLM + yield)
```

---

## 2. Prerequisites & Setup

### Required Tools

```bash
# Install jq for JSON processing
sudo apt install -y jq curl

# Verify installation
jq --version
curl --version

# Install Stellar CLI
cargo install --locked stellar-cli --features opt
```

### Environment Setup

```bash
cat > .env << 'EOF'
# Stellar Testnet Configuration
STELLAR_NETWORK=testnet
STELLAR_RPC_URL=https://soroban-testnet.stellar.org:443
STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"

# Admin Wallet (your funded testnet account)
ADMIN_STELLAR_SECRET=SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
ADMIN_STELLAR_ADDRESS=GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# DeFindex Configuration
DEFINDEX_API_KEY=
DEFINDEX_VAULT_ADDRESS=

# Asset Addresses (Testnet)
XLM_CONTRACT_ADDRESS=CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
BLEND_STRATEGY=CDVLOSPJPQOTB6ZCWO5VSGTOLGMKTXSFWYTUP572GTPNOWX4F76X3HPM

# Buffer Contract (to be deployed)
BUFFER_CONTRACT_ID=
EOF

# Load environment
source .env
```

### Fund Your Testnet Account

```bash
# Generate new keypair
stellar keys generate admin --network testnet

# Get public address
export ADMIN_STELLAR_ADDRESS=$(stellar keys address admin)

# Fund via friendbot
curl "https://friendbot.stellar.org?addr=$ADMIN_STELLAR_ADDRESS"

# Verify balance (should show 10,000 XLM)
stellar balance --address $ADMIN_STELLAR_ADDRESS --network testnet
```

---

## 3. Authentication Process

### Step 1: Register with DeFindex

```bash
curl -X POST https://api.defindex.io/register \
  -H "Content-Type: application/json" \
  -d '{
    "username": "your_username",
    "password": "SecurePassword123!",
    "email": "your@email.com"
  }' | jq .
```

### Step 2: Login and Get Access Token

```bash
curl -X POST https://api.defindex.io/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "your@email.com",
    "password": "SecurePassword123!"
  }' | jq -r '.access_token' > /tmp/access_token.txt

export ACCESS_TOKEN=$(cat /tmp/access_token.txt)
```

### Step 3: Generate Persistent API Key

```bash
curl -X POST https://api.defindex.io/api-keys/generate \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" | jq -r '.key' > /tmp/api_key.txt

export DEFINDEX_API_KEY=$(cat /tmp/api_key.txt)

# Save to .env
echo "DEFINDEX_API_KEY=$DEFINDEX_API_KEY" >> .env
```

---

## 4. Asset & Strategy Discovery

### Fetch Testnet XLM Contracts

```bash
curl "https://raw.githubusercontent.com/paltalabs/defindex/main/public/testnet.contracts.json" \
  | jq '.ids | {xlm: .xlm, xlm_blend_strategy: .XLM_blend_strategy}'
```

**Response:**

```json
{
  "xlm": "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  "xlm_blend_strategy": "CDVLOSPJPQOTB6ZCWO5VSGTOLGMKTXSFWYTUP572GTPNOWX4F76X3HPM"
}
```

### Verify XLM Strategy Compatibility

```bash
# Query existing XLM vault
curl "https://api.defindex.io/vault/CCLV4H7WTLJVZBD3KTOEOE7CAGBNVJEU4OCBQZ6PV67SNJLKG7CE7UBV?network=testnet" \
  -H "Authorization: Bearer $DEFINDEX_API_KEY" | jq '.assets[0]'
```

**Confirms:**

```json
{
  "address": "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  "symbol": "XLM",
  "strategies": [
    {
      "address": "CDVLOSPJPQOTB6ZCWO5VSGTOLGMKTXSFWYTUP572GTPNOWX4F76X3HPM",
      "name": "XLM Blend Strategy"
    }
  ]
}
```

---

## 5. Vault Creation with XLM

### Create XLM Vault Request

```bash
curl -X POST "https://api.defindex.io/factory/create-vault?network=testnet" \
  -H "Authorization: Bearer $DEFINDEX_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"caller\": \"$ADMIN_STELLAR_ADDRESS\",
    \"roles\": {
      \"0\": \"$ADMIN_STELLAR_ADDRESS\",
      \"1\": \"$ADMIN_STELLAR_ADDRESS\",
      \"2\": \"$ADMIN_STELLAR_ADDRESS\",
      \"3\": \"$ADMIN_STELLAR_ADDRESS\"
    },
    \"vault_fee_bps\": 25,
    \"upgradable\": true,
    \"name_symbol\": {
      \"name\": \"REDI XLM Vault\",
      \"symbol\": \"REDIXLM\"
    },
    \"assets\": [
      {
        \"address\": \"$XLM_CONTRACT_ADDRESS\",
        \"strategies\": [
          {
            \"address\": \"$BLEND_STRATEGY\",
            \"name\": \"XLM_blend_strategy\",
            \"paused\": false
          }
        ]
      }
    ]
  }" | jq . | tee vault_creation_response.json
```

### Extract XDR for Signing

```bash
export XDR=$(cat vault_creation_response.json | jq -r '.xdr')
```

---

## 6. Transaction Signing & Submission

### Create Signing Script

```bash
cat > /tmp/sign_vault.mjs << 'EOF'
import { Keypair, Networks, Transaction } from '@stellar/stellar-sdk';

const secret = process.env.ADMIN_STELLAR_SECRET;
const xdr = process.env.XDR;

if (!secret || !xdr) {
  console.error('Missing ADMIN_STELLAR_SECRET or XDR');
  process.exit(1);
}

const keypair = Keypair.fromSecret(secret);
const tx = new Transaction(xdr, Networks.TESTNET);
tx.sign(keypair);

const signedXdr = tx.toEnvelope().toXDR('base64');

const response = await fetch('https://horizon-testnet.stellar.org/transactions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ tx: signedXdr })
});

const result = await response.json();
console.log(JSON.stringify(result, null, 2));

if (result.successful) {
  console.error(`\n✅ Transaction successful!`);
  console.error(`Hash: ${result.hash}`);
} else {
  console.error('\n❌ Failed');
  process.exit(1);
}
EOF
```

### Sign and Submit

```bash
cd /tmp
npm install @stellar/stellar-sdk 2>/dev/null

ADMIN_STELLAR_SECRET=$ADMIN_STELLAR_SECRET XDR=$XDR node sign_vault.mjs | tee tx_result.json
```

**Success Output:**

```
✅ Transaction successful!
Hash: 00ffb4d9XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

---

## 7. Vault Verification

### Extract Vault Address from Stellar Expert

```bash
TX_HASH=$(cat tx_result.json | jq -r '.hash')
echo "View transaction: https://stellar.expert/explorer/testnet/tx/$TX_HASH"
```

**Look for the contract creation result. Example:**

```
GDFG…REKJ invoked contract CDSC…4A32 `create_defindex_vault(...)` → CDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

**Save the vault address:**

```bash
export DEFINDEX_VAULT_ADDRESS="XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
echo "DEFINDEX_VAULT_ADDRESS=$DEFINDEX_VAULT_ADDRESS" >> .env
```

### Verify Vault Status

```bash
curl "https://api.defindex.io/vault/$DEFINDEX_VAULT_ADDRESS?network=testnet" \
  -H "Authorization: Bearer $DEFINDEX_API_KEY" | jq '{name, symbol, assets: .assets[0].symbol, total: .totalManagedFunds[0].total_amount}'
```

---

## 8. Buffer Contract Integration

### Why a Buffer Contract?

The Buffer contract adds an application layer between users and the DeFindex vault, enabling:

- Custom deposit/withdrawal logic
- Protected vs. available share management
- Cross-chain bridging support
- Automatic rebalancing on first deposit

### Integration with `contractimport!`

**Problem:** Manually defining vault traits is error-prone and causes type mismatches.

**Solution:** Use `contractimport!` to generate types directly from the deployed vault WASM.

### Step 1: Download Vault WASM

```bash
cd ~/your-project/contracts/buffer

stellar contract fetch \
  --id $DEFINDEX_VAULT_ADDRESS \
  --network testnet \
  --rpc-url https://soroban-testnet.stellar.org:443 \
  --out-file defindex_vault.wasm

# Verify
ls -lh defindex_vault.wasm
```

**File location:** Place in the same directory as `Cargo.toml`.

```
contracts/buffer/
├── Cargo.toml
├── defindex_vault.wasm  ← HERE
└── src/
    └── lib.rs
```

### Step 2: Import Vault in Buffer Contract

**In `src/lib.rs`:**

```rust
#![no_std]

use soroban_sdk::{contract, contractimpl, Address, Env, Vec, vec};

// Import DeFindex vault contract
mod vault_import {
    soroban_sdk::contractimport!(file = "defindex_vault.wasm");
}
use vault_import::Client as DeFindexVaultClient;

#[contract]
pub struct BufferContract;

#[contractimpl]
impl BufferContract {
    pub fn deposit(env: Env, user: Address, amount: i128) -> DepositResult {
        let vault_client = DeFindexVaultClient::new(&env, &vault_address);

        // Deposit to vault with automatic investment
        let result = vault_client.deposit(
            &vec![&env, amount],
            &vec![&env, min_shares],
            &user,
            &true  // invest=true
        );

        let shares_minted = result.1;

        // Check if first deposit (invested_amount == 0)
        let funds_after = vault_client.fetch_total_managed_funds();
        let invested = funds_after.get(0).unwrap().invested_amount;

        // Force investment if idle funds detected
        if invested == 0 {
            let total_idle = funds_after.get(0).unwrap().idle_amount;

            vault_client.rebalance(
                &user,
                &vec![&env, vault_import::Instruction::Invest(blend_strategy, total_idle)]
            );
        }

        // ... rest of deposit logic
    }
}
```

### Step 3: Compile and Deploy Buffer

```bash
cd ~/your-project/contracts/buffer

cargo build --target wasm32-unknown-unknown --release

cd ~/your-project

stellar contract deploy \
  --wasm contracts/buffer/target/wasm32-unknown-unknown/release/buffer_contract.wasm \
  --source-account $ADMIN_STELLAR_SECRET \
  --network testnet \
  --rpc-url https://soroban-testnet.stellar.org:443 \
  --network-passphrase "Test SDF Network ; September 2015" \
  -- \
  --admin $ADMIN_STELLAR_ADDRESS \
  --vault $DEFINDEX_VAULT_ADDRESS \
  --asset $XLM_CONTRACT_ADDRESS \
  --blend_strategy $BLEND_STRATEGY
```

**Save the Buffer contract ID:**

```bash
export BUFFER_CONTRACT_ID="XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
echo "BUFFER_CONTRACT_ID=$BUFFER_CONTRACT_ID" >> .env
```

### Step 4: Test Deposit Flow

```bash
# Approve Buffer to spend XLM
stellar contract invoke \
  --id $XLM_CONTRACT_ADDRESS \
  --source-account $ADMIN_STELLAR_SECRET \
  --network testnet \
  --rpc-url https://soroban-testnet.stellar.org:443 \
  --network-passphrase "Test SDF Network ; September 2015" \
  -- \
  approve \
  --from $ADMIN_STELLAR_ADDRESS \
  --spender $BUFFER_CONTRACT_ID \
  --amount 10000000000 \
  --expiration_ledger 3110000

# Deposit 100 XLM
stellar contract invoke \
  --id $BUFFER_CONTRACT_ID \
  --source-account $ADMIN_STELLAR_SECRET \
  --network testnet \
  --rpc-url https://soroban-testnet.stellar.org:443 \
  --network-passphrase "Test SDF Network ; September 2015" \
  -- \
  deposit \
  --user $ADMIN_STELLAR_ADDRESS \
  --amount 1000000000
```

### Step 5: Verify Investment

```bash
curl "https://api.defindex.io/vault/$DEFINDEX_VAULT_ADDRESS?network=testnet" \
  -H "Authorization: Bearer $DEFINDEX_API_KEY" | jq '.totalManagedFunds[0]'
```

**Expected (funds invested):**

```json
{
  "idle_amount": "0",
  "invested_amount": "1000000000",
  "total_amount": "1000000000"
}
```

---

## 9. Troubleshooting

### Funds Remain Idle After Deposit

**Symptom:** `idle_amount > 0`, `invested_amount = 0`

**Cause:** Using old Buffer contract without rebalance logic.

**Solution:** Redeploy Buffer with latest code including automatic rebalance:

```rust
if invested == 0 && idle_amount > 0 {
    vault_client.rebalance(
        &user,
        &vec![&env, vault_import::Instruction::Invest(strategy, idle_amount)]
    );
}
```

### "Account not found" API Error

**Cause:** Missing `?network=testnet` parameter.

**Solution:** Always include network parameter:

```bash
# WRONG
curl "https://api.defindex.io/vault/$VAULT_ADDRESS"

# CORRECT
curl "https://api.defindex.io/vault/$VAULT_ADDRESS?network=testnet"
```

### Type Mismatch Errors in Rust

**Symptom:** `Error(Object, UnexpectedSize)` or similar type errors.

**Cause:** Manual trait definition doesn't match actual vault contract.

**Solution:** Use `contractimport!` as documented in Section 8.

### Buffer Deployment Uses Wrong Contract ID

**Symptom:** Deposits go to old buffer, rebalance doesn't execute.

**Solution:** Always verify `$BUFFER_CONTRACT_ID` after each deployment:

```bash
# Update .env with correct ID
export BUFFER_CONTRACT_ID="XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"

# Verify it's set
echo $BUFFER_CONTRACT_ID
```

---

## Summary

✅ Created XLM vault with Blend strategy  
✅ Deployed Buffer contract with automatic rebalance  
✅ Integrated vault using `contractimport!`  
✅ Verified funds are invested and generating yield

### Key Addresses Reference

```bash
XLM_CONTRACT_ADDRESS=CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
BLEND_STRATEGY=CDVLOSPJPQOTB6ZCWO5VSGTOLGMKTXSFWYTUP572GTPNOWX4F76X3HPM
DEFINDEX_VAULT_ADDRESS=CDKXLXJOJ7YSLTMXQQRX6H3VRVYELWUMMS3HT2A65BUD2C7OGQ7Q6IWC
BUFFER_CONTRACT_ID=XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

---

### Next Steps

1. **Integrate vault into your application** - Use the vault contract ID to build deposit/withdraw flows
2. **Test deposits** - Send XLM to the vault via your application
3. **Monitor yield** - Track `totalManagedFunds` to see strategy performance
4. **Scale to production** - Repeat process on mainnet with real assets

---

## Additional Resources

- **DeFindex Documentation:** https://docs.defindex.io
- **DeFindex GitHub:** https://github.com/paltalabs/defindex
- **Stellar Expert (Testnet):** https://stellar.expert/explorer/testnet
- **Soroban Documentation:** https://soroban.stellar.org/docs

---

**Last Updated:** February 2026
