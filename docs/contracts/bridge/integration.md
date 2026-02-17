# Bridge + Buffer Integration Guide

## Overview

This document describes how the Bridge Contract integrates with the Buffer Contract to enable collateralized installment payment plans.

---

## Architecture

```
┌─────────────────┐
│   User Wallet   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Bridge Contract │ ◄─── Creates plans, collects installments
└────────┬────────┘
         │ (calls)
         ▼
┌─────────────────┐
│  Buffer Contract │ ◄─── Manages user funds + collateral
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  DeFindex Vault │ ◄─── Yield generation
└─────────────────┘
```

---

## Buffer Contract Interface

The Bridge Contract expects the Buffer Contract to implement these functions:

### Required Functions

#### 1. `get_balance(user: Address) -> BufferBalance`

**Purpose:** Get user's share balances

**Returns:**
```rust
pub struct BufferBalance {
    pub available_shares: i128,    // Shares user can freely use
    pub protected_shares: i128,    // Shares locked as collateral
    pub total_deposited: i128,     // Historical total deposited
    pub last_deposit_ts: u64,      // Last deposit timestamp
    pub version: u64,              // Balance version
}
```

**Used by Bridge:**
- `create_plan`: Check if user has sufficient collateral
- `collect_installment`: Determine payment source

---

#### 2. `lock_shares(user: Address, shares: i128) -> LockResult`

**Purpose:** Lock shares as collateral for a plan

**Flow:**
```
available_shares -= shares
protected_shares += shares
total remains same
```

**Returns:**
```rust
pub struct LockResult {
    pub shares_locked: i128,       // Amount locked
    pub new_available: i128,       // Updated available
    pub new_protected: i128,       // Updated protected
}
```

**Used by Bridge:**
- `create_plan`: Lock shares when plan is created

**Validations in Buffer:**
- ✅ `shares > 0`
- ✅ `available_shares >= shares`
- ✅ User authenticated

---

#### 3. `unlock_shares(user: Address, shares: i128) -> LockResult`

**Purpose:** Release collateral back to available

**Flow:**
```
protected_shares -= shares
available_shares += shares
total remains same
```

**Used by Bridge:**
- `collect_installment`: When plan completes, unlock remaining shares

**Validations in Buffer:**
- ✅ `shares > 0`
- ✅ `protected_shares >= shares`
- ✅ Bridge contract authenticated (only Bridge can unlock)

---

#### 4. `debit_available(user: Address, shares: i128, to: Address) -> WithdrawResult`

**Purpose:** Debit shares from available and transfer value to merchant

**Flow:**
```
1. Convert shares to token amounts via DeFindex
2. Burn shares from user's available
3. Transfer tokens to merchant
4. Return withdrawal details
```

**Returns:**
```rust
pub struct WithdrawResult {
    pub shares_burned: i128,            // Shares removed from user
    pub amounts_received: Vec<i128>,    // Token amounts per asset
    pub new_available_balance: i128,    // Updated available
    pub from_protected: bool,           // Always false for this function
}
```

**Used by Bridge:**
- `collect_installment`: First attempt when collecting payment

**Validations in Buffer:**
- ✅ `shares > 0`
- ✅ `available_shares >= shares`
- ✅ User authenticated
- ✅ Merchant address valid

---

#### 5. `debit_protected(user: Address, shares: i128, to: Address) -> WithdrawResult`

**Purpose:** Debit shares from protected (fallback when available insufficient)

**Flow:**
```
1. Convert shares to token amounts via DeFindex
2. Burn shares from user's protected
3. Transfer tokens to merchant
4. Return withdrawal details
```

**Returns:**
```rust
pub struct WithdrawResult {
    pub shares_burned: i128,
    pub amounts_received: Vec<i128>,
    pub new_available_balance: i128,
    pub from_protected: bool,           // Always true for this function
}
```

**Used by Bridge:**
- `collect_installment`: Fallback when available insufficient

**Validations in Buffer:**
- ✅ `shares > 0`
- ✅ `protected_shares >= shares`
- ✅ Bridge contract authenticated (only Bridge can debit protected)

---

#### 6. `get_values(user: Address) -> (i128, i128, i128)`

**Purpose:** Get user's balance values in token terms (not shares)

**Returns:**
```rust
(
    available_value,  // Value of available shares in tokens
    protected_value,  // Value of protected shares in tokens
    total_value       // Total value (available + protected)
)
```

**Used by Bridge:**
- `create_plan`: Validate collateralization in user-friendly token amounts
- `get_plan_summary`: Display current values to user

**Calculation in Buffer:**
```rust
available_value = shares_to_amount(available_shares)
protected_value = shares_to_amount(protected_shares)
total_value = available_value + protected_value
```

---

#### 7. `shares_for_amount(amount: i128) -> i128`

**Purpose:** Calculate how many shares are needed for a token amount

**Returns:** Number of shares

**Used by Bridge:**
- `create_plan`: Calculate shares to lock for plan total
- `collect_installment`: Calculate shares to debit per installment

**Calculation in Buffer:**
```rust
// Inverse of shares_to_amount
shares = (amount * total_shares) / total_value_in_vault
```

---

## Integration Flow Examples

### Example 1: Create Plan

**Scenario:**
- User has Buffer: available=$10k, protected=$0
- Wants plan: $3k in 3 installments

**Bridge calls Buffer:**

1. **Check collateral:**
```rust
let (available, _, total) = buffer.get_values(user);
// Returns: (10000, 0, 10000)

assert!(3000 <= 10000);  // ✅ Total sufficient
assert!(3000 <= 10000);  // ✅ Available sufficient
```

2. **Calculate shares:**
```rust
let shares = buffer.shares_for_amount(3000);
// Returns: e.g., 300 shares (if 1 share = $10)
```

3. **Lock shares:**
```rust
let result = buffer.lock_shares(user, 300);
// Returns: LockResult {
//   shares_locked: 300,
//   new_available: 700,
//   new_protected: 300
// }
```

**Buffer state after:**
- available_shares: 700 (was 1000)
- protected_shares: 300 (was 0)
- total_shares: 1000 (unchanged)

---

### Example 2: Collect from Available

**Scenario:**
- Plan: $3k total, 3 installments of $1k each
- Buffer: available=700 shares, protected=300 shares
- Installment 1 due: $1k

**Bridge calls Buffer:**

1. **Calculate shares for installment:**
```rust
let shares = buffer.shares_for_amount(1000);
// Returns: 100 shares
```

2. **Check balance:**
```rust
let balance = buffer.get_balance(user);
// Returns: BufferBalance {
//   available_shares: 700,
//   protected_shares: 300,
//   ...
// }

assert!(700 >= 100);  // ✅ Enough available
```

3. **Debit from available:**
```rust
let result = buffer.debit_available(user, 100, merchant);
// Returns: WithdrawResult {
//   shares_burned: 100,
//   amounts_received: [1000, 0, 0],  // USDC amount
//   new_available_balance: 600,
//   from_protected: false
// }
```

**Buffer state after:**
- available_shares: 600 (was 700)
- protected_shares: 300 (unchanged)
- Merchant received: $1k

**Bridge updates:**
```rust
// Proportionally reduce protected
shares_to_unlock = (100 * 300) / 3000 = 10
protected_shares = 300 - 10 = 290
```

---

### Example 3: Collect from Protected (Fallback)

**Scenario:**
- Plan: $3k total, 3 installments
- Buffer: available=50 shares (only $500), protected=250 shares
- Installment 2 due: $1k

**Bridge calls Buffer:**

1. **Calculate shares:**
```rust
let shares = buffer.shares_for_amount(1000);
// Returns: 100 shares
```

2. **Check balance:**
```rust
let balance = buffer.get_balance(user);
// available_shares: 50  ❌ Not enough
// protected_shares: 250 ✅ Enough
```

3. **Debit from protected (fallback):**
```rust
let result = buffer.debit_protected(user, 100, merchant);
// Returns: WithdrawResult {
//   shares_burned: 100,
//   amounts_received: [1000, 0, 0],
//   new_available_balance: 50,
//   from_protected: true
// }
```

**Buffer state after:**
- available_shares: 50 (unchanged)
- protected_shares: 150 (was 250)
- Merchant received: $1k

**Bridge updates:**
```rust
// Direct deduction from protected
protected_shares = 250 - 100 = 150
```

---

### Example 4: Plan Completion

**Scenario:**
- All 3 installments paid
- Protected shares remaining: 50

**Bridge calls Buffer:**

```rust
buffer.unlock_shares(user, 50);
// Returns: LockResult {
//   shares_locked: 0,
//   new_available: 100,
//   new_protected: 0
// }
```

**Buffer state after:**
- available_shares: 100 (was 50)
- protected_shares: 0 (was 50)
- All collateral released

---

## Authorization Model

### Buffer → Bridge Trust

**Buffer must trust Bridge to:**
- Call `unlock_shares` (only Bridge can release collateral)
- Call `debit_protected` (only Bridge can touch protected funds)

**Implementation:**
```rust
// In Buffer Contract
fn unlock_shares(env: Env, user: Address, shares: i128) {
    let bridge = env.storage().instance().get("bridge_address").unwrap();
    bridge.require_auth();  // Only Bridge can call
    
    // ... unlock logic
}
```

### User → Bridge Trust

**User trusts Bridge to:**
- Correctly calculate installments
- Only collect when due
- Release collateral when plan completes

**Mitigation:**
- Open source contract (auditable)
- Formal verification (recommended)
- Bug bounty program

---

## Error Handling

### Buffer Errors → Bridge

**Bridge must handle:**

1. **InsufficientShares:**
```rust
// Buffer: Not enough shares to lock/debit
// Bridge: Return InsufficientAvailable or InsufficientFunds
```

2. **Unauthorized:**
```rust
// Buffer: Caller not authorized
// Bridge: Return BufferContractError
```

3. **InvalidAmount:**
```rust
// Buffer: Amount <= 0 or too large
// Bridge: Validate before calling
```

### Bridge Errors → UI

**Frontend must handle:**

1. **InsufficientCollateral:**
```
Message: "Your Buffer balance ($X) is less than requested amount ($Y)"
Action: "Deposit more funds or reduce amount"
```

2. **InsufficientFunds (during collection):**
```
Message: "Installment payment failed due to insufficient funds"
Action: "Deposit funds to avoid default"
```

---

## Deployment Order

### 1. Deploy Buffer Contract

```bash
soroban contract deploy \
  --wasm buffer_contract.wasm \
  --source deployer \
  --network testnet

# Save contract ID
BUFFER_ID=CXXXX...
```

### 2. Deploy Bridge Contract

```bash
soroban contract deploy \
  --wasm bridge_contract.wasm \
  --source deployer \
  --network testnet

# Save contract ID
BRIDGE_ID=CXXXX...
```

### 3. Configure Buffer → Bridge Trust

```bash
# In Buffer Contract, set authorized bridge
soroban contract invoke \
  --id $BUFFER_ID \
  --source deployer \
  --network testnet \
  -- \
  set_bridge_address \
  --bridge $BRIDGE_ID
```

### 4. Test Integration

```bash
# Create test user
soroban keys generate --global testuser --network testnet

# Fund user's Buffer
soroban contract invoke \
  --id $BUFFER_ID \
  --source testuser \
  --network testnet \
  -- \
  deposit \
  --amount 10000

# Create Bridge plan
soroban contract invoke \
  --id $BRIDGE_ID \
  --source testuser \
  --network testnet \
  -- \
  create_plan \
  --user $(soroban keys address testuser) \
  --merchant GMERCHANT... \
  --total_amount 3000 \
  --installments_count 3 \
  --due_dates '[1234567890, 1234567900, 1234567910]' \
  --buffer_contract $BUFFER_ID
```

---

## Monitoring Integration

### Events to Track

**From Bridge:**
- `plan_new`: New plan created
- `inst_paid`: Installment collected

**From Buffer:**
- `shares_locked`: Collateral locked
- `shares_unlocked`: Collateral released
- `withdrawal`: Funds transferred to merchant

### Metrics to Monitor

1. **Collateral Ratio:**
```
ratio = protected_value / total_active_plans_amount
Target: Always >= 100%
```

2. **Collection Success Rate:**
```
success_rate = paid_installments / due_installments
Target: >= 95%
```

3. **Default Rate:**
```
default_rate = defaulted_plans / total_plans
Target: <= 5%
```

---

## Testing Integration

### Mock Buffer Contract

For testing Bridge in isolation:

```rust
// test/mock_buffer.rs
#[contractimpl]
impl MockBuffer {
    pub fn get_balance(env: Env, user: Address) -> BufferBalance {
        // Return test balance
        BufferBalance {
            available_shares: 1000,
            protected_shares: 0,
            total_deposited: 10000,
            last_deposit_ts: 0,
            version: 1,
        }
    }
    
    // ... implement other functions with test logic
}
```

### Integration Test Example

```rust
#[test]
fn test_full_plan_lifecycle() {
    let env = Env::default();
    
    // Deploy contracts
    let buffer_id = deploy_buffer(&env);
    let bridge_id = deploy_bridge(&env);
    
    let user = Address::generate(&env);
    let merchant = Address::generate(&env);
    
    // Fund user in Buffer
    buffer::deposit(&env, &buffer_id, &user, 10000);
    
    // Create plan in Bridge
    let plan_id = bridge::create_plan(
        &env,
        &bridge_id,
        &user,
        &merchant,
        3000,
        3,
        vec![&env, 100, 200, 300],
        &buffer_id,
    );
    
    // Verify Buffer state
    let balance = buffer::get_balance(&env, &buffer_id, &user);
    assert_eq!(balance.available_shares, 700);
    assert_eq!(balance.protected_shares, 300);
    
    // Collect installments
    // ... test collection flow
    
    // Verify completion
    // ... verify unlock
}
```

---

## Troubleshooting

### Issue: Lock fails with "Insufficient Available"

**Check:**
1. User's actual available balance
2. Protected balance from other plans
3. Calculation: available = total - protected

**Fix:**
- User deposits more
- User waits for other plans to complete
- Reduce requested amount

---

### Issue: Debit fails with "Unauthorized"

**Check:**
1. Bridge address correctly set in Buffer
2. Bridge contract making the call (not user directly)

**Fix:**
- Reconfigure Buffer with correct Bridge address
- Redeploy if needed

---

### Issue: Share calculation mismatch

**Check:**
1. Buffer's exchange rate (shares ↔ tokens)
2. Timing of DeFindex yield updates
3. Rounding errors in calculations

**Fix:**
- Use `shares_for_amount()` consistently
- Accept small rounding differences (< 0.01%)
- Log actual vs expected for debugging

---

## Version Compatibility

| Bridge | Buffer | Soroban SDK | Status |
|--------|--------|-------------|--------|
| 0.1.0  | 0.1.0  | 22.0.0      | ✅ Compatible |
| 0.2.0  | 0.1.0  | 22.0.0      | ⚠️ Backwards compatible |
| 0.1.0  | 0.2.0  | 22.0.0      | ❌ Requires Bridge upgrade |

---

*Integration Guide - Bridge + Buffer Contracts*
*REDI Project - February 2026*