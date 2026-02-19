# Buffer Contract Deployment Guide

**Target Audience:** Developers deploying the Buffer contract to Stellar testnet  
**Prerequisites:** Rust toolchain installed, DeFindex vault created, testnet wallet funded

---

## Table of Contents

1. [Prerequisites Verification](#1-prerequisites-verification)
2. [Project Structure Setup](#2-project-structure-setup)
3. [DeFindex Vault Integration](#3-defindex-vault-integration)
4. [Contract Compilation](#4-contract-compilation)
5. [System Dependencies Installation](#5-system-dependencies-installation)
6. [Stellar CLI Installation](#6-stellar-cli-installation)
7. [Contract Deployment](#7-contract-deployment)
8. [Verification](#8-verification)
9. [Troubleshooting](#9-troubleshooting)

---

## 1. Prerequisites Verification

### Check Required Tools

```bash
# Verify Rust installation
rustc --version
# Expected: rustc 1.74.0 or newer

# Verify Cargo
cargo --version

# Verify WASM target
rustup target list | grep wasm32-unknown-unknown
# Should show: wasm32-unknown-unknown (installed)

# If not installed:
rustup target add wasm32-unknown-unknown
```

### Verify Environment Variables

```bash
# Load your environment
cd ~/your-project-root
source .env

# Verify all required variables are set
echo "Admin Address: ${ADMIN_STELLAR_ADDRESS:0:5}..."
echo "Admin Secret: ${ADMIN_STELLAR_SECRET:0:5}..."
echo "Vault Address: ${DEFINDEX_VAULT_ADDRESS:0:5}..."
echo "XLM Address: ${XLM_CONTRACT_ADDRESS:0:5}..."
echo "Blend Strategy: ${BLEND_STRATEGY:0:5}..."

# All should show values starting with expected prefixes
```

**Required `.env` configuration:**

```bash
# Stellar Testnet Configuration
STELLAR_NETWORK=testnet
STELLAR_RPC_URL=https://soroban-testnet.stellar.org:443
STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"

# Admin Wallet (REPLACE WITH YOUR TESTNET ACCOUNT)
ADMIN_STELLAR_SECRET=SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
ADMIN_STELLAR_ADDRESS=GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# DeFindex Configuration (REPLACE WITH YOUR ACTUAL ADDRESSES)
DEFINDEX_API_KEY=sk_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
DEFINDEX_VAULT_ADDRESS=CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# Testnet Asset Addresses (these are public, can be left as-is)
XLM_CONTRACT_ADDRESS=CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
BLEND_STRATEGY=CDVLOSPJPQOTB6ZCWO5VSGTOLGMKTXSFWYTUP572GTPNOWX4F76X3HPM

# Buffer Contract (will be generated during deployment)
BUFFER_CONTRACT_ID=
```

---

## 2. Project Structure Setup

### Navigate to Contracts Directory

```bash
cd ~/your-project-root/contracts/soroban
```

### Create Buffer Project Structure

```bash
# Create buffer directory
mkdir -p buffer/src

# Create Cargo.toml
cat > buffer/Cargo.toml << 'EOF'
[package]
name = "buffer-contract"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
soroban-sdk = "22.0.0"

[dev-dependencies]
soroban-sdk = { version = "22.0.0", features = ["testutils"] }

[profile.release]
opt-level = "z"
overflow-checks = true
debug = 0
strip = "symbols"
debug-assertions = false
panic = "abort"
codegen-units = 1
lto = true

[profile.release-with-logs]
inherits = "release"
debug-assertions = true
EOF
```

### Verify Structure

```bash
cd buffer

# Check files exist
ls -la
# Should show: Cargo.toml, src/

ls -la src/
# Should show: lib.rs

# Verify lib.rs is not empty
wc -l src/lib.rs
# Should show ~600-650 lines
```

---

## 3. DeFindex Vault Integration

### Why Use `contractimport!`?

Manual trait definitions cause type mismatches and runtime errors. The professional approach is to import the deployed vault WASM directly.

### Step 1: Download Vault WASM

```bash
cd ~/your-project-root/contracts/soroban/buffer

# Download the deployed vault WASM
stellar contract fetch \
  --id $DEFINDEX_VAULT_ADDRESS \
  --network testnet \
  --rpc-url https://soroban-testnet.stellar.org:443 \
  --out-file defindex_vault.wasm

# Verify download
ls -lh defindex_vault.wasm
# Expected: ~60-80KB file
```

**File location:** Must be in the same directory as `Cargo.toml`.

```
contracts/buffer/
├── Cargo.toml
├── defindex_vault.wasm  ← HERE
└── src/
    └── lib.rs
```

### Step 2: Import Vault in Contract

**In `src/lib.rs` (beginning of file):**

```rust
#![no_std]
#![allow(unused_variables)]

use soroban_sdk::{
    contract, contractimpl, contracttype, Address, Env, Symbol, Vec, vec
};

// Import DeFindex vault contract types
mod vault_import {
    soroban_sdk::contractimport!(file = "defindex_vault.wasm");
}
use vault_import::Client as DeFindexVaultClient;

// ... rest of your contract code
```

### Step 3: Use Vault Client in Deposit Function

**Example usage:**

```rust
pub fn deposit(env: Env, user: Address, amount: i128) -> DepositResult {
    // ... validation logic ...

    let vault_client = DeFindexVaultClient::new(&env, &vault_address);

    // Deposit with automatic investment
    let result = vault_client.deposit(
        &vec![&env, amount],
        &vec![&env, min_shares],
        &user,
        &true  // invest=true
    );

    let shares_minted = result.1;

    // Check if funds need manual rebalance (first deposit scenario)
    let funds_after = vault_client.fetch_total_managed_funds();
    let asset_allocation = funds_after.get(0).unwrap();

    if asset_allocation.invested_amount == 0 && asset_allocation.idle_amount > 0 {
        let blend_strategy: Address = env.storage().instance()
            .get(&DataKey::BlendStrategy)
            .unwrap_or_else(|| panic!("Blend strategy not configured"));

        vault_client.rebalance(
            &user,
            &vec![&env, vault_import::Instruction::Invest(
                blend_strategy,
                asset_allocation.idle_amount
            )]
        );
    }

    // ... rest of deposit logic ...
}
```

### Benefits of This Approach

✅ **Type-safe** - Generated from actual deployed contract  
✅ **Auto-updated** - Re-download WASM when vault upgrades  
✅ **No manual maintenance** - Traits stay in sync automatically  
✅ **Compile-time errors** - Catches incompatibilities before deploy

---

## 4. Contract Compilation

### Clean Build

```bash
cd ~/your-project-root/contracts/soroban/buffer

# Remove previous builds
cargo clean

# Build for WASM
cargo build --target wasm32-unknown-unknown --release
```

**Expected output:**

```
   Compiling buffer-contract v0.1.0
    Finished `release` profile [optimized] target(s) in 30-40s
```

### Verify WASM Output

```bash
ls -lh target/wasm32-unknown-unknown/release/buffer_contract.wasm
```

**Expected:** File size between 18KB and 30KB

```
-rwxrwxr-x 2 user user 22K date time buffer_contract.wasm
```

**Note:** 18-30KB is correct for optimized Soroban contracts.

---

## 5. System Dependencies Installation

### Install Required Libraries

```bash
sudo apt update
sudo apt install -y libdbus-1-dev libudev-dev pkg-config build-essential
```

### Verify Installation

```bash
# Check dbus
pkg-config --modversion dbus-1
# Expected: version number (e.g., 1.14.10)

# Check libudev
pkg-config --modversion libudev
# Expected: version number (e.g., 255)
```

---

## 6. Stellar CLI Installation

### Install Latest Stellar CLI

```bash
cargo install --locked stellar-cli --force
```

**This may take 5-10 minutes.**

### Verify Installation

```bash
stellar --version
```

**Expected:** `stellar 25.x.x` or newer

### Configure Testnet Network

```bash
stellar network add \
  --global testnet \
  --rpc-url https://soroban-testnet.stellar.org:443 \
  --network-passphrase "Test SDF Network ; September 2015"

# Verify
stellar network ls
```

---

## 7. Contract Deployment

### Navigate to Project Root

```bash
cd ~/your-project-root
source .env
```

### Deploy Buffer Contract

```bash
stellar contract deploy \
  --wasm contracts/soroban/buffer/target/wasm32-unknown-unknown/release/buffer_contract.wasm \
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

**Expected output:**

```
ℹ️  Simulating install transaction…
ℹ️  Signing transaction: abc123...
🌎 Submitting install transaction…
ℹ️  Using wasm hash ca1526170dc7843061a18b08d339b628c1a3822b4efe23d9b70ae623827db327
ℹ️  Simulating deploy transaction…
ℹ️  Signing transaction: def456...
🌎 Submitting deploy transaction…
✅ Deployed!
CD2224H2SJ5JDVFJU7NNKPQDTA6OTNG5GZDIYQNEY6VHTSBWID6W6S4V
```

### Save Contract ID

```bash
# Copy the contract ID from output (last line starting with C...)
export BUFFER_CONTRACT_ID="CD2224H2SJ5JDVFJU7NNKPQDTA6OTNG5GZDIYQNEY6VHTSBWID6W6S4V"

# Add to .env
echo "BUFFER_CONTRACT_ID=$BUFFER_CONTRACT_ID" >> .env
source .env

# Verify
echo $BUFFER_CONTRACT_ID
```

---

## 8. Verification

### Test Contract Configuration

```bash
stellar contract invoke \
  --id $BUFFER_CONTRACT_ID \
  --source-account $ADMIN_STELLAR_SECRET \
  --network testnet \
  --rpc-url https://soroban-testnet.stellar.org:443 \
  --network-passphrase "Test SDF Network ; September 2015" \
  -- \
  get_config
```

**Expected:**

```json
{
  "min_deposit_interval": 2,
  "slippage_tolerance_bps": "50"
}
```

### Test Deposit Flow

```bash
# Step 1: Approve Buffer to spend XLM
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

# Step 2: Deposit 100 XLM (1 billion stroops)
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

**Expected:**

```json
{
  "amount_deposited": "1000000000",
  "new_available_balance": "1000000000",
  "shares_minted": "1000000000",
  "timestamp": 1771524429
}
```

### Verify Funds are Invested

```bash
curl "https://api.defindex.io/vault/$DEFINDEX_VAULT_ADDRESS?network=testnet" \
  -H "Authorization: Bearer $DEFINDEX_API_KEY" \
  | jq '.totalManagedFunds[0]'
```

**Expected (funds invested, not idle):**

```json
{
  "asset": "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  "idle_amount": "0",
  "invested_amount": "1000000000",
  "total_amount": "1000000000"
}
```

✅ **Success:** `idle_amount = 0` means funds are generating yield.

---

## 9. Troubleshooting

### Funds Remain Idle After Deposit

**Symptom:** `idle_amount > 0`, `invested_amount = 0`

**Cause:** Using wrong Buffer contract ID (old deployment without rebalance logic).

**Solution:**

```bash
# Verify you're using the LATEST deployed contract
echo $BUFFER_CONTRACT_ID

# If unsure, redeploy and update .env with new ID
stellar contract deploy ...
```

### "Account not found" API Error

**Cause:** Missing `?network=testnet` query parameter.

**Solution:** Always include network in DeFindex API calls:

```bash
# WRONG
curl "https://api.defindex.io/vault/$VAULT_ADDRESS"

# CORRECT
curl "https://api.defindex.io/vault/$VAULT_ADDRESS?network=testnet"
```

### Type Mismatch / `Error(Object, UnexpectedSize)`

**Cause:** Manual vault trait definition doesn't match deployed contract.

**Solution:** Use `contractimport!` as documented in Section 3.

### "Missing required argument 'blend_strategy'"

**Cause:** Constructor signature changed to require `blend_strategy` parameter.

**Solution:** Always provide all 4 parameters:

```bash
-- \
  --admin $ADMIN_STELLAR_ADDRESS \
  --vault $DEFINDEX_VAULT_ADDRESS \
  --asset $XLM_CONTRACT_ADDRESS \
  --blend_strategy $BLEND_STRATEGY  # ← Required
```

### Contract ID Not Updating in .env

**Symptom:** `echo $BUFFER_CONTRACT_ID` shows old ID after deployment.

**Solution:**

```bash
# Manually edit .env
nano .env

# Find line: BUFFER_CONTRACT_ID=COLD...
# Replace with: BUFFER_CONTRACT_ID=CNEW...
# Save (Ctrl+X, Y, Enter)

# Reload
source .env
echo $BUFFER_CONTRACT_ID  # Should show new ID
```

---

## Summary

**Successful deployment checklist:**

✅ Rust and WASM toolchain installed  
✅ DeFindex vault WASM downloaded  
✅ Buffer contract compiled with `contractimport!`  
✅ System dependencies installed  
✅ Stellar CLI v25.x.x installed  
✅ Contract deployed with vault integration  
✅ Deposit tested successfully  
✅ Funds invested and generating yield (XLM)

**Your Buffer contract is live on testnet with automatic investment.**

---

## Next Steps

1. **Backend Integration** - Build API endpoints wrapping contract calls
2. **User Wallet Management** - Integrate Crossmint or similar
3. **Frontend Development** - Create deposit/withdrawal UI
4. **Yield Tracking** - Display real-time APY from vault
5. **Production Deployment** - Repeat process on mainnet

---

**Last Updated:** February 2026
