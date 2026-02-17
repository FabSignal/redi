# Buffer Contract Deployment Guide

**Target Audience:** Developers deploying the Buffer contract to Stellar testnet  
**Prerequisites:** Rust toolchain installed, DeFindex vault created, testnet wallet funded

---

## Table of Contents

1. [Prerequisites Verification](#1-prerequisites-verification)
2. [Project Structure Setup](#2-project-structure-setup)
3. [Contract Compilation](#3-contract-compilation)
4. [System Dependencies Installation](#4-system-dependencies-installation)
5. [Stellar CLI Installation](#5-stellar-cli-installation)
6. [Contract Deployment](#6-contract-deployment)
7. [Verification](#7-verification)
8. [Troubleshooting](#8-troubleshooting)

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
echo "Admin Address: $ADMIN_STELLAR_ADDRESS"
echo "Admin Secret: ${ADMIN_STELLAR_SECRET:0:5}..."
echo "Vault Address: $DEFINDEX_VAULT_ADDRESS"
echo "USDC Address: $USDC_CONTRACT_ADDRESS"

# All should show actual values, not empty
```

**If any variables are missing, they must be in your `.env` file:**

```bash
ADMIN_STELLAR_SECRET=SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
ADMIN_STELLAR_ADDRESS=GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
DEFINDEX_VAULT_ADDRESS=CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
USDC_CONTRACT_ADDRESS=CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU
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

### Add Contract Source Files

**Main contract (lib.rs):**

Place your complete Buffer contract code in `buffer/src/lib.rs`.

**DeFindex client (defindex_vault.rs):**

```bash
cat > buffer/src/defindex_vault.rs << 'EOF'
use soroban_sdk::{contractclient, contracttype, Address, Env, Vec};

#[contractclient(name = "DeFindexVaultClient")]
pub trait DeFindexVault {
    fn deposit(
        env: Env,
        amounts_desired: Vec<i128>,
        amounts_min: Vec<i128>,
        from: Address,
        invest: bool,
    ) -> (Vec<i128>, i128, i128);

    fn withdraw(
        env: Env,
        withdraw_shares: i128,
        amounts_min: Vec<i128>,
        from: Address,
    ) -> Vec<i128>;

    fn total_supply(env: Env) -> i128;

    fn fetch_total_managed_funds(env: Env) -> Vec<AssetInvestmentAllocation>;
}

#[contracttype]
#[derive(Clone)]
pub struct AssetInvestmentAllocation {
    pub asset: Address,
    pub total_amount: i128,
}
EOF
```

### Verify Structure

```bash
cd buffer

# Check files exist
ls -la
# Should show: Cargo.toml, src/

ls -la src/
# Should show: lib.rs, defindex_vault.rs

# Verify lib.rs is not empty
wc -l src/lib.rs
# Should show ~590-600 lines
```

---

## 3. Contract Compilation

### Clean Build

```bash
cd ~/your-project-root/contracts/soroban/buffer

# Remove any previous builds
cargo clean

# Build for WASM
cargo build --target wasm32-unknown-unknown --release
```

**Expected output:**

```
   Compiling buffer-contract v0.1.0
warning: trait `DeFindexVault` is never used
 --> src/defindex_vault.rs:4:11
  |
4 | pub trait DeFindexVault {
  |           ^^^^^^^^^^^^^
warning: `buffer-contract` (lib) generated 1 warning
    Finished `release` profile [optimized] target(s) in 30-40s
```

**The warning is harmless - the trait is used by the `#[contractclient]` macro.**

### Verify WASM Output

```bash
ls -lh target/wasm32-unknown-unknown/release/buffer_contract.wasm
```

**Expected:** File size between 15KB and 30KB

```
-rwxrwxr-x 2 user user 18K date time buffer_contract.wasm
```

---

## 4. System Dependencies Installation

Stellar CLI requires system libraries. Install them before proceeding.

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

# If either command fails, the library is not installed correctly
```

---

## 5. Stellar CLI Installation

### Install Latest Stellar CLI

```bash
cargo install --locked stellar-cli --force
```

**This will take 5-10 minutes.** Wait for completion without interruption.

### Verify Installation

```bash
stellar --version
```

**Expected:** `stellar 25.x.x` or newer

If you see version 21.x.x or older, the installation failed. Retry the cargo install command.

### Configure Testnet Network

```bash
stellar network add \
  --global testnet \
  --rpc-url https://soroban-testnet.stellar.org:443 \
  --network-passphrase "Test SDF Network ; September 2015"

# Verify network was added
stellar network ls
```

**Expected output should include:**

```
testnet
local
futurenet
mainnet
```

---

## 6. Contract Deployment

### Navigate to Project Root

```bash
cd ~/your-project-root
source .env
```

### Deploy and Initialize Contract

**This single command deploys the WASM and initializes the contract:**

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
  --asset $USDC_CONTRACT_ADDRESS
```

**Expected successful output:**

```
ℹ️  Simulating install transaction…
ℹ️  Signing transaction: fe11bf08913052821be3c9fb98b4d7e9102dedc151639cb8227f89b86fa47268
🌎 Submitting install transaction…
ℹ️  Using wasm hash c6ed33f7fa57f6b8c6d986baae1c9375a104658295277e02563dc4441fbe504d
ℹ️  Simulating deploy transaction…
ℹ️  Transaction hash is 05d8e1441feac4fad7b3bfe7b985f66645ebd4eabd81e9394bdb3b89496a3c49
🔗 https://stellar.expert/explorer/testnet/tx/05d8e1441feac4fad7b3bfe7b985f66645ebd4eabd81e9394bdb3b89496a3c49
ℹ️  Signing transaction: 05d8e1441feac4fad7b3bfe7b985f66645ebd4eabd81e9394bdb3b89496a3c49
🌎 Submitting deploy transaction…
🔗 https://lab.stellar.org/r/testnet/contract/CCTLT56VQEOIUPNVYCNIN647LH7AJWAB766OPG27QLCVRBDEFYS6RD4X
✅ Deployed!
CCTLT56VQEOIUPNVYCNIN647LH7AJWAB766OPG27QLCVRBDEFYS6RD4X
```

### Save Contract ID

```bash
# Copy the contract ID from the output (the C... address at the end)
# Example: CCTLT56VQEOIUPNVYCNIN647LH7AJWAB766OPG27QLCVRBDEFYS6RD4X

# Add to .env file
echo "BUFFER_CONTRACT_ID=YOUR_ACTUAL_CONTRACT_ID" >> .env

# Reload environment
source .env

# Verify it was saved
echo $BUFFER_CONTRACT_ID
```

---

## 7. Verification

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

**Expected output:**

```
ℹ️  Simulation identified as read-only. Send by rerunning with `--send=yes`.
{"min_deposit_interval":2,"slippage_tolerance_bps":"50"}
```

### Test Total Stats

```bash
stellar contract invoke \
  --id $BUFFER_CONTRACT_ID \
  --source-account $ADMIN_STELLAR_SECRET \
  --network testnet \
  --rpc-url https://soroban-testnet.stellar.org:443 \
  --network-passphrase "Test SDF Network ; September 2015" \
  -- \
  get_total_stats
```

**Expected output:**

```
ℹ️  Simulation identified as read-only. Send by rerunning with `--send=yes`.
{"total_available":"0","total_deposited":"0","total_protected":"0","unique_users":0}
```

### Test Pause Status

```bash
stellar contract invoke \
  --id $BUFFER_CONTRACT_ID \
  --source-account $ADMIN_STELLAR_SECRET \
  --network testnet \
  --rpc-url https://soroban-testnet.stellar.org:443 \
  --network-passphrase "Test SDF Network ; September 2015" \
  -- \
  is_paused
```

**Expected output:**

```
ℹ️  Simulation identified as read-only. Send by rerunning with `--send=yes`.
false
```

### Verify on Stellar Expert

Visit your contract on Stellar Expert:

```
https://stellar.expert/explorer/testnet/contract/YOUR_CONTRACT_ID
```

Replace `YOUR_CONTRACT_ID` with your actual contract ID.

---

## 8. Troubleshooting

### Issue: "xdr value invalid"

**Cause:** Outdated stellar-cli or wrong SDK version in contract.

**Solution:**

```bash
# Verify stellar-cli version
stellar --version
# Must be 25.x.x or newer

# Verify SDK version in Cargo.toml
grep soroban-sdk contracts/soroban/buffer/Cargo.toml
# Must show: soroban-sdk = "22.0.0"

# If wrong, update Cargo.toml and rebuild:
cd contracts/soroban/buffer
cargo clean
cargo build --target wasm32-unknown-unknown --release
```

### Issue: "non-default constructor not supported"

**Cause:** Contract compiled with SDK < 22.0.0

**Solution:**

```bash
cd contracts/soroban/buffer

# Update Cargo.toml to use soroban-sdk = "22.0.0"
nano Cargo.toml
# Change the version, save

# Clean and rebuild
cargo clean
cargo build --target wasm32-unknown-unknown --release

# Redeploy
cd ~/your-project-root
stellar contract deploy ...
```

### Issue: "Missing required argument 'admin'"

**Cause:** Constructor parameters not provided or incorrect syntax.

**Solution:**

Ensure you have the `--` separator followed by constructor arguments:

```bash
stellar contract deploy \
  --wasm ... \
  --source-account ... \
  --network testnet \
  --rpc-url ... \
  --network-passphrase "..." \
  -- \
  --admin $ADMIN_STELLAR_ADDRESS \
  --vault $DEFINDEX_VAULT_ADDRESS \
  --asset $USDC_CONTRACT_ADDRESS
```

The `--` is critical - it separates CLI args from contract constructor args.

### Issue: "failed to compile libdbus-sys" or "libudev"

**Cause:** Missing system dependencies.

**Solution:**

```bash
sudo apt update
sudo apt install -y libdbus-1-dev libudev-dev pkg-config build-essential

# Verify installation
pkg-config --modversion dbus-1
pkg-config --modversion libudev

# Retry stellar-cli installation
cargo install --locked stellar-cli --force
```

### Issue: Contract Compiles but is Only 18KB

**This is NORMAL.** Soroban contracts are highly optimized:

- 15-30KB is typical for well-optimized contracts
- The `opt-level = "z"` setting in Cargo.toml aggressively reduces size
- `lto = true` performs link-time optimization
- `strip = "symbols"` removes debug information

**Do NOT worry if your WASM is 18-25KB - this is correct.**

### Issue: Environment Variables Not Set

**Symptom:** Commands fail with "empty variable" errors.

**Solution:**

```bash
# Verify .env file exists
cat .env

# Must contain:
ADMIN_STELLAR_SECRET=S...
ADMIN_STELLAR_ADDRESS=G...
DEFINDEX_VAULT_ADDRESS=C...
USDC_CONTRACT_ADDRESS=C...

# Reload environment
source .env

# Verify variables loaded
echo $ADMIN_STELLAR_ADDRESS
# Should show your G... address
```

---

## Summary

**Successful deployment checklist:**

✅ Rust and WASM toolchain installed  
✅ Buffer contract compiled (18-25KB WASM)  
✅ System dependencies installed (libdbus, libudev)  
✅ Stellar CLI v25.x.x installed  
✅ Contract deployed to testnet  
✅ Contract initialized with admin, vault, and USDC  
✅ Configuration verified via `get_config`  
✅ Contract ID saved to `.env`

**Your Buffer contract is now live on testnet and ready for integration.**

---

## Next Steps

1. **Obtain testnet USDC** - Get USDC from Soroswap testnet faucet
2. **Test deposit flow** - Manually deposit USDC to verify vault integration
3. **Implement backend** - Build API endpoints for deposits/withdrawals
4. **Integrate Crossmint** - Add user wallet management
5. **Build UI** - Create user interface for deposits and yield tracking

---

**Last Updated:** February 2026
