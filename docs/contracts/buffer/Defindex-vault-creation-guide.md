# DeFindex Vault Creation Guide

**Target Audience:** Developers integrating DeFindex yield vaults into Stellar/Soroban applications  
**Prerequisites:** Basic understanding of Stellar blockchain, testnet funded wallet, curl/jq installed

---

## Table of Contents

1. [Understanding DeFindex Architecture](#1-understanding-defindex-architecture)
2. [Prerequisites & Setup](#2-prerequisites--setup)
3. [Authentication Process](#3-authentication-process)
4. [Asset & Strategy Discovery](#4-asset--strategy-discovery)
5. [Vault Creation](#5-vault-creation)
6. [Transaction Signing & Submission](#6-transaction-signing--submission)
7. [Vault Verification](#7-vault-verification)
8. [Troubleshooting](#8-troubleshooting)

---

## 1. Understanding DeFindex Architecture

### What is DeFindex?

DeFindex is a decentralized vault protocol on Stellar that automatically deploys user assets into yield-generating strategies. Think of it as a programmable asset manager that routes capital to optimized DeFi positions.

### Key Concepts

**Vault:** A Soroban smart contract that holds user deposits and manages strategy allocations. Each vault can support multiple assets and strategies.

**Strategy:** A specific DeFi protocol integration (e.g., Blend lending, Soroswap liquidity pools) where the vault deploys capital to earn yield.

**Asset:** A Stellar Asset Contract (SAC) that the vault accepts for deposits (e.g., USDC, XLM).

**Shares:** When you deposit into a vault, you receive vault shares representing your proportional ownership. Share value appreciates as strategies generate yield.

### Network-Specific Contract Addresses

**CRITICAL:** Contract addresses differ completely between testnet and mainnet. Always verify you're using the correct network.

| Network     | Purpose               | Contracts Repository     |
| ----------- | --------------------- | ------------------------ |
| **Testnet** | Development & testing | `testnet.contracts.json` |
| **Mainnet** | Production            | `mainnet.contracts.json` |

### Architecture Flow

```
User Deposit (USDC)
        ↓
DeFindex Vault Contract
        ↓
Strategy Selection (Blend, Soroswap, etc.)
        ↓
Yield Generation
        ↓
Share Value Appreciation
        ↓
User Withdrawal (USDC + yield)
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
```

### Environment Setup

Add to `.env` file the configuration:

```bash
cat > .env << 'EOF'
# Stellar Testnet Configuration
STELLAR_NETWORK=testnet
STELLAR_RPC_URL=https://soroban-testnet.stellar.org:443
STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"

# Admin Wallet (your funded testnet account)
ADMIN_STELLAR_SECRET=SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
ADMIN_STELLAR_ADDRESS=GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# DeFindex Configuration (to be filled)
DEFINDEX_API_KEY=
DEFINDEX_VAULT_ADDRESS=
EOF

# Load environment
source .env
```

### Fund Your Testnet Account

If you don't have a funded testnet account:

```bash
# Generate new keypair (if needed)
stellar keys generate admin --network testnet

# Get public address
stellar keys address admin

# Fund via friendbot
curl "https://friendbot.stellar.org?addr=$(stellar keys address admin)"

# Verify balance
stellar keys balance admin --network testnet
# Should show: 10000.0000000 XLM
```

---

## 3. Authentication Process

DeFindex API requires authentication for vault creation. This is a multi-step process.

### Step 1: User Registration

**Note:** Skip this if you already have a DeFindex account.

```bash
curl -X POST https://api.defindex.io/register \
  -H "Content-Type: application/json" \
  -d '{
    "username": "your_username",
    "password": "SecurePassword123!",
    "email": "your@email.com"
  }' | jq .
```

**Expected Response:**

```json
{
  "message": "User registered successfully"
}
```

### Step 2: Login to Obtain Access Token

```bash
# Login (uses EMAIL, not username)
curl -X POST https://api.defindex.io/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "your@email.com",
    "password": "SecurePassword123!"
  }' | jq .
```

**Expected Response:**

```json
{
  "username": "your_username",
  "role": "USER",
  "access_token": "eyJhbGciOiJ................",
  "refresh_token": "eyJhbGciOiJ..............."
}
```

**Save the access token:**

```bash
ACCESS_TOKEN="eyJhbGciOi.............."
```

### Step 3: Generate API Key

Access tokens expire. Generate a persistent API key for programmatic access:

```bash
curl -X POST https://api.defindex.io/api-keys/generate \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" | jq .
```

**Expected Response:**

```json
{
  "key": "sk_9b4................",
  "id": 101
}
```

**Save to environment:**

```bash
# Add to .env
echo "DEFINDEX_API_KEY=sk_9b.................." >> .env

# Reload
source .env
```

---

## 4. Asset & Strategy Discovery

### Critical Network Parameter

**ALL DeFindex API calls MUST include `?network=testnet` query parameter.**

Without this parameter, the API defaults to mainnet, causing "Account not found" errors for testnet addresses.

### Fetch Testnet Contract Addresses

DeFindex maintains an official contract registry:

```bash
curl "https://raw.githubusercontent.com/paltalabs/defindex/main/public/testnet.contracts.json" | jq .
```

**Response Structure:**

```json
{
  "ids": {
    "USDC_blend_strategy": "CALLOM5I7XLQPPOPQMYAHUWW4N7O3JKT42KQ4ASEEVBXDJQNJOALFSUY",
    "XLM_blend_strategy": "CDVLOSPJPQOTB6ZCWO5VSGTOLGMKTXSFWYTUP572GTPNOWX4F76X3HPM",
    "defindex_factory": "CDSCWE4GLNBYYTES2OCYDFQA2LLY4RBIAX6ZI32VSUXD7GO6HRPO4A32",
    "usdc_paltalabs_vault": "CBMVK2JK6NTOT2O4HNQAIQFJY232BHKGLIMXDVQVHIIZKDACXDFZDWHN",
    "xlm_paltalabs_vault": "CCLV4H7WTLJVZBD3KTOEOE7CAGBNVJEU4OCBQZ6PV67SNJLKG7CE7UBV"
  },
  "hashes": { ... }
}
```

### Discover Existing Vaults

To find compatible asset addresses, query existing vaults:

```bash
curl "https://api.defindex.io/vault/discover?network=testnet" \
  -H "Authorization: Bearer $DEFINDEX_API_KEY" | jq .
```

### Inspect Vault Configuration

Examine an existing vault to understand asset/strategy relationships:

```bash
# Query PaltaLabs USDC vault
curl "https://api.defindex.io/vault/CBMVK2JK6NTOT2O4HNQAIQFJY232BHKGLIMXDVQVHIIZKDACXDFZDWHN?network=testnet" \
  -H "Authorization: Bearer $DEFINDEX_API_KEY" | jq .
```

**Key Information Extracted:**

```json
{
  "name": "DeFindex-Vault-Defindex Vault",
  "symbol": "DFXV",
  "assets": [
    {
      "address": "CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU",
      "symbol": "USDC",
      "strategies": [
        {
          "address": "CALLOM5I7XLQPPOPQMYAHUWW4N7O3JKT42KQ4ASEEVBXDJQNJOALFSUY",
          "name": "USDC Blend Strategy",
          "paused": false
        }
      ]
    }
  ],
  "totalManagedFunds": [...]
}
```

**Store discovered addresses:**

```bash
# Testnet USDC SAC address
USDC_CONTRACT_ADDRESS="CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU"

# USDC Blend strategy
USDC_BLEND_STRATEGY="CALLOM5I7XLQPPOPQMYAHUWW4N7O3JKT42KQ4ASEEVBXDJQNJOALFSUY"

# Add to .env
echo "USDC_CONTRACT_ADDRESS=$USDC_CONTRACT_ADDRESS" >> .env
```

---

## 5. Vault Creation

### API Endpoint Schema

Retrieve the official API specification:

```bash
curl https://api.defindex.io/api-json | jq '.paths["/factory/create-vault"].post.requestBody'
```

### Request Parameters Explained

| Parameter                       | Type    | Description                                   |
| ------------------------------- | ------- | --------------------------------------------- |
| `caller`                        | String  | Your Stellar public address (G...)            |
| `roles`                         | Object  | Role assignments using numeric keys           |
| `roles["0"]`                    | String  | Emergency Manager - can pause vault in crisis |
| `roles["1"]`                    | String  | Fee Receiver - receives management fees       |
| `roles["2"]`                    | String  | Vault Manager - can update strategies         |
| `roles["3"]`                    | String  | Rebalance Manager - can rebalance allocations |
| `vault_fee_bps`                 | Integer | Management fee in basis points (25 = 0.25%)   |
| `upgradable`                    | Boolean | Allow future contract upgrades                |
| `name_symbol.name`              | String  | Vault display name                            |
| `name_symbol.symbol`            | String  | Vault token symbol                            |
| `assets[].address`              | String  | Asset contract address (C...)                 |
| `assets[].strategies[].address` | String  | Strategy contract address (C...)              |
| `assets[].strategies[].name`    | String  | Strategy identifier                           |
| `assets[].strategies[].paused`  | Boolean | Strategy active status                        |

### Create Your Vault

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
      \"name\": \"My Application Vault\",
      \"symbol\": \"MYVAULT\"
    },
    \"assets\": [
      {
        \"address\": \"$USDC_CONTRACT_ADDRESS\",
        \"strategies\": [
          {
            \"address\": \"$USDC_BLEND_STRATEGY\",
            \"name\": \"USDC_blend_strategy\",
            \"paused\": false
          }
        ]
      }
    ]
  }" | jq . > vault_creation_response.json
```

**Expected Response:**

```json
{
  "simulation_result": "SUCCESS",
  "xdr": "AAAAAgAAAADKbDkD5HzBCs/tVx/cS34Kd6ZLgcmaASC6k7EMY0kSCACjWukADfwDAAAABAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA..."
}
```

**Extract XDR for signing:**

```bash
XDR=$(cat vault_creation_response.json | jq -r '.xdr')
echo $XDR
```

---

## 6. Transaction Signing & Submission

The API returns **unsigned** XDR. You must sign with your private key and submit to Stellar network.

### Install Stellar SDK

```bash
cd /tmp
npm install @stellar/stellar-sdk 2>/dev/null || npm install @stellar/stellar-sdk
```

### Create Signing Script

```bash
cat > /tmp/sign_and_submit.mjs << 'EOF'
import pkg from '@stellar/stellar-sdk';
const { Keypair, Networks, Transaction } = pkg;

const secret = process.env.ADMIN_STELLAR_SECRET;
const xdr = process.env.XDR;

if (!secret || !xdr) {
  console.error('Error: ADMIN_STELLAR_SECRET and XDR environment variables required');
  process.exit(1);
}

try {
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
    console.error('\n✅ Transaction successful!');
    console.error(`Transaction Hash: ${result.hash}`);
  } else {
    console.error('\n❌ Transaction failed');
    process.exit(1);
  }
} catch (error) {
  console.error('Error:', error.message);
  process.exit(1);
}
EOF
```

### Sign and Submit Transaction

```bash
cd /tmp
ADMIN_STELLAR_SECRET=$ADMIN_STELLAR_SECRET XDR=$XDR node sign_and_submit.mjs | tee transaction_result.json
```

**Expected Success Output:**

```json
{
  "id": "7bb9f39a30fd45c746dad62cf205a34cfc3248355512f680af7dc5ca9d35b781",
  "successful": true,
  "hash": "7bb9f39a30fd45c746dad62cf205a34cfc3248355512f680af7dc5ca9d35b781",
  "ledger": 1062124,
  "created_at": "2026-02-17T06:15:28Z",
  "fee_charged": "9308142"
}
```

---

## 7. Vault Verification

### Extract Vault Contract Address

**Method 1: Stellar Expert (Recommended)**

Visit: `https://stellar.expert/explorer/testnet/tx/{TRANSACTION_HASH}`

Look for the contract invocation result:

```
GDFG…REKJ invoked contract CDSC…4A32 `create_defindex_vault(...)` → CAAY…64XP
```

The address after `→` is your vault contract ID.

**Method 2: Horizon API**

```bash
TX_HASH="7bb9f39a30fd45c746dad62cf205a34cfc3248355512f680af7dc5ca9d35b781"

curl "https://horizon-testnet.stellar.org/transactions/$TX_HASH/operations" \
  | jq -r '.._embedded.records[0].contract_id' 2>/dev/null \
  || echo "Check transaction manually at https://stellar.expert/explorer/testnet/tx/$TX_HASH"
```

### Save Vault Address

```bash
VAULT_ADDRESS="CAAYE3PAJEPWRUQ7S2JGAUVKFB3SJLPTDRIGTPAJ5OP3UJIWBYJM64XP"

echo "DEFINDEX_VAULT_ADDRESS=$VAULT_ADDRESS" >> .env
source .env
```

### Verify Vault Functionality

```bash
# Query vault information
curl "https://api.defindex.io/vault/$DEFINDEX_VAULT_ADDRESS?network=testnet" \
  -H "Authorization: Bearer $DEFINDEX_API_KEY" | jq .
```

**Expected Response:**

```json
{
  "name": "My Application Vault",
  "symbol": "MYVAULT",
  "assets": [
    {
      "address": "CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU",
      "symbol": "USDC",
      "strategies": [...]
    }
  ],
  "totalManagedFunds": [],
  "totalSupply": "0"
}
```

---

## 8. Troubleshooting

### "Account not found" Error

**Symptom:** API returns account/vault not found despite correct address.

**Cause:** Missing `?network=testnet` query parameter - API defaulted to mainnet.

**Solution:**

```bash
# WRONG
curl "https://api.defindex.io/vault/$VAULT_ADDRESS"

# CORRECT
curl "https://api.defindex.io/vault/$VAULT_ADDRESS?network=testnet"
```

### "Strategy does not support asset" Error

**Symptom:** `VaultErrors.StrategyDoesNotSupportAsset`

**Cause:** Asset contract address doesn't match strategy's supported asset.

**Solution:** Query existing vaults to find correct asset/strategy pairs:

```bash
curl "https://api.defindex.io/vault/discover?network=testnet" \
  -H "Authorization: Bearer $DEFINDEX_API_KEY" | jq .
```

### "Forbidden resource" Error

**Symptom:** 403 Forbidden or authentication failure.

**Cause:** Invalid or expired API key.

**Solution:** Regenerate API key:

```bash
# Login to get fresh access token
ACCESS_TOKEN=$(curl -s -X POST https://api.defindex.io/login \
  -H "Content-Type: application/json" \
  -d '{"email":"your@email.com","password":"YourPassword"}' \
  | jq -r '.access_token')

# Generate new API key
curl -X POST https://api.defindex.io/api-keys/generate \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq .
```

### Transaction Submission Fails

**Symptom:** `txBadAuth` or signature verification failure.

**Cause:** XDR not properly signed before submission.

**Solution:** Verify signing process:

```bash
# Ensure ADMIN_STELLAR_SECRET is set correctly
echo ${ADMIN_STELLAR_SECRET:0:5}...  # Should start with 'S'

# Re-run signing script
ADMIN_STELLAR_SECRET=$ADMIN_STELLAR_SECRET XDR=$XDR node /tmp/sign_and_submit.mjs
```

### Vault Not Confirmed After Creation

**Symptom:** Vault address extracted but queries fail.

**Cause:** Blockchain hasn't finalized the transaction yet (~5-10 seconds).

**Solution:** Poll with retry logic:

```bash
for i in {1..20}; do
  echo "Attempt $i: Checking vault..."

  RESULT=$(curl -s "https://api.defindex.io/vault/$DEFINDEX_VAULT_ADDRESS?network=testnet" \
    -H "Authorization: Bearer $DEFINDEX_API_KEY")

  if echo $RESULT | jq -e '.name' > /dev/null 2>&1; then
    echo "✅ Vault confirmed!"
    echo $RESULT | jq .
    break
  fi

  sleep 3
done
```

---

## Summary

You've successfully:

✅ Authenticated with DeFindex API  
✅ Discovered testnet assets and strategies  
✅ Created a vault with USDC + Blend strategy  
✅ Signed and submitted the vault creation transaction  
✅ Verified vault deployment on testnet

**Your vault is now ready to accept deposits and generate yield.**

### Key Addresses Reference

```bash
# View all your configuration
cat .env | grep -E "DEFINDEX|USDC"
```

**Expected Output:**

```
DEFINDEX_API_KEY=sk_9b4f783d...
DEFINDEX_VAULT_ADDRESS=CAAYE3PAJEPW...
USDC_CONTRACT_ADDRESS=CAQCFVLOBK5G...
```

### Next Steps

1. **Integrate vault into your application** - Use the vault contract ID to build deposit/withdraw flows
2. **Test deposits** - Send USDC to the vault via your application
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
