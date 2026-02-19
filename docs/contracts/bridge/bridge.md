# Bridge Contract - Technical Documentation

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [State Management](#state-management)
3. [Function Specifications](#function-specifications)
4. [Business Logic](#business-logic)
5. [Error Handling](#error-handling)
6. [Security Considerations](#security-considerations)
7. [Gas Optimization](#gas-optimization)

---

## Architecture Overview

### Purpose

The Bridge Contract enables users to make purchases through installment payment plans, using their Buffer balance as collateral. It ensures merchants receive guaranteed payments while users maintain liquidity.

### Key Concepts

**Collateralization:**
- Plans require 100% collateralization
- Maximum plan amount = User's total Buffer balance
- Shares are locked (not withdrawn) during the plan

**Payment Flow:**
1. User creates plan → Shares locked in Buffer
2. Installment becomes due → Worker attempts collection
3. Collection tries Available first → Falls back to Protected
4. All installments paid → Remaining shares unlocked

**Shares vs Tokens:**
- Buffer uses shares (like LP tokens) that appreciate over time
- Bridge stores amounts in tokens for user clarity
- Conversion happens via `shares_for_amount()` when needed

---

## State Management

### Storage Keys

```rust
pub enum DataKey {
    Plan(String),           // plan_id -> BridgePlan
    UserPlans(Address),     // user -> Vec<plan_id>
    PlanCounter,            // Global counter for unique IDs
}
```

### Storage Types

- **Instance Storage**: Counter (ephemeral, resets on upgrade)
- **Persistent Storage**: Plans and user plan lists (permanent)

### State Transitions

**Plan Status:**
```
Active → Completed  (all installments paid successfully)
Active → Defaulted  (one installment failed due to insufficient funds)
```

**Installment Status:**
```
Pending → Paid     (successfully collected)
Pending → Failed   (insufficient funds)
```

---

## Function Specifications

### create_plan

**Purpose:** Create a new installment payment plan

**Flow:**
```
1. Validate inputs (amount, dates, installment count)
2. Check Buffer collateral (total >= amount, available >= amount)
3. Calculate shares needed for total amount
4. Lock shares in Buffer Contract
5. Generate unique plan ID
6. Calculate installment distribution
7. Store plan and update user's plan list
8. Emit plan_new event
```

**Validations:**
- ✅ User authentication (require_auth)
- ✅ Amount > 0
- ✅ 1 ≤ installments ≤ 12
- ✅ Due dates count matches installments count
- ✅ All due dates in the future
- ✅ Buffer total ≥ amount (collateralization)
- ✅ Buffer available ≥ amount (can lock)
- ✅ Shares calculation > 0

**Installment Distribution:**
```rust
amount_per_installment = total_amount / installments_count
remainder = total_amount % installments_count

// Each installment gets equal amount
// Last installment gets remainder to ensure exact total
installment[i].amount = amount_per_installment
installment[last].amount = amount_per_installment + remainder
```

**Example:**
```
Total: $1000
Installments: 3

Installment 1: $333
Installment 2: $333
Installment 3: $334 (333 + remainder 1)
```

---

### collect_installment

**Purpose:** Collect a due installment payment

**Flow:**
```
1. Load plan from storage
2. Validate user authentication
3. Find installment by number
4. Check installment is pending and due
5. Calculate shares needed for installment amount
6. Try collection from Available
   ├─ Success → Update protected_shares proportionally
   └─ Insufficient → Try Protected
      ├─ Success → Reduce protected_shares directly
      └─ Insufficient → Mark failed, plan defaulted
7. Update installment status
8. Check if all paid → Complete plan + unlock remaining shares
9. Save plan
10. Emit inst_paid event
```

**Payment Logic:**
```rust
shares_needed = buffer.shares_for_amount(installment.amount)

if available_shares >= shares_needed {
    // CASE 1: Pay from Available
    debit_available(shares_needed)
    
    // Proportionally reduce protected shares
    shares_to_unlock = (shares_needed * total_shares) / total_amount
    protected_shares -= shares_to_unlock
    
} else if protected_shares >= shares_needed {
    // CASE 2: Pay from Protected (fallback)
    debit_protected(shares_needed)
    
    // Directly reduce protected shares
    protected_shares -= shares_needed
    
} else {
    // CASE 3: Insufficient funds
    installment.status = Failed
    plan.status = Defaulted
    return InsufficientFunds
}
```

**Completion Logic:**
```rust
if all_installments_paid {
    plan.status = Completed
    
    if protected_shares > 0 {
        unlock_shares(protected_shares)
        protected_shares = 0
    }
}
```

---

### get_plan

**Purpose:** Retrieve full plan details

**Returns:**
- Plan ID
- User and merchant addresses
- Total amount and shares
- All installments with status
- Protected shares remaining
- Plan status

---

### get_user_plans

**Purpose:** List all plan IDs for a user

**Use Case:** Dashboard showing user's active/completed plans

---

### get_next_due

**Purpose:** Find next installment to collect

**Logic:**
```rust
for each installment in plan {
    if status == Pending && due_date <= now {
        return installment
    }
}
return None
```

**Use Case:** Worker automation to process due payments

---

### get_plan_summary

**Purpose:** Get plan with real-time Buffer values

**Returns:**
- Full BridgePlan
- Current available value (in tokens)
- Current protected value (in tokens)

**Use Case:** UI displaying plan status with current collateral values

---

## Business Logic

### Collateralization Model

**Rule:** `total_amount <= buffer.total AND total_amount <= buffer.available`

**Example Scenarios:**

**Scenario 1: Simple case**
```
Buffer: available=$10k, protected=$0, total=$10k
Request: $5k in 3 installments
✅ Approved: 5k <= 10k AND 5k <= 10k
Locks: $5k shares
```

**Scenario 2: Multiple plans**
```
Buffer: available=$8k, protected=$7k (other plan), total=$15k
Request: $6k in 2 installments
✅ Approved: 6k <= 15k AND 6k <= 8k
Locks: $6k shares
After: available=$2k, protected=$13k, total=$15k
```

**Scenario 3: Insufficient available**
```
Buffer: available=$3k, protected=$7k (other plan), total=$10k
Request: $5k in 2 installments
❌ Rejected: 5k <= 10k ✓ BUT 5k > 3k ✗
Error: InsufficientAvailable
```

---

### Payment Priority

**Strategy:** Maximize user liquidity

1. **First:** Available shares (user keeps flexibility)
2. **Second:** Protected shares (last resort)
3. **Fail:** Mark defaulted (don't force-liquidate)

**Rationale:**
- Paying from Available preserves user's ability to make new purchases
- Only touches Protected when absolutely necessary
- Never liquidates user's entire balance (preserves relationship)

---

### Share Unlocking Logic

**Why proportional unlocking?**

When paying from Available, the collateral risk decreases proportionally. We unlock shares to reflect this.

**Formula:**
```
shares_to_unlock = (shares_paid * total_shares) / total_amount
```

**Example:**
```
Plan: $1000, 10 shares locked
Payment 1: $333 paid from Available
Shares used: 3.33 shares
Unlock: (3.33 * 10) / 1000 ≈ 0.033 shares (keeps proportion)
```

**When paying from Protected:**
Direct deduction because we're already using the collateral.

---

## Error Handling

### Error Categories

**User Errors (4xx):**
- InvalidAmount, InvalidInstallments, DatesMismatch
- InsufficientCollateral, InsufficientAvailable
- User should fix input

**State Errors (4xx):**
- PlanNotFound, InstallmentNotFound
- AlreadyPaid, NotDueYet
- Invalid operation for current state

**System Errors (5xx):**
- BufferContractError, InvalidShares
- External system failure

### Error Recovery

**Idempotency:**
- Plan creation: Counter ensures unique IDs
- Collection: Status checks prevent double payment
- Safe to retry failed transactions

**Partial Failures:**
- If lock_shares succeeds but DB save fails → Shares locked but no plan
- Mitigation: Lock is last action before storage
- Recovery: Manual unlock or wait for timeout (if implemented)

---

## Security Considerations

### Authentication

**All state-changing functions require auth:**
```rust
user.require_auth()  // Soroban verifies signature
```

### Reentrancy

**Not applicable:** Soroban doesn't support reentrancy by design

### Front-running

**Mitigation:** All transactions require user signature
- Attacker can't create plan on behalf of user
- Attacker can't collect installment without user auth

### Overflow Protection

**All arithmetic uses checked operations:**
```rust
.checked_mul()
.checked_div()
.checked_sub()
.unwrap_or(0)  // Safe fallback
```

### Storage Exhaustion

**Rate limiting:** Implemented at Buffer level
**Plan limits:** Max 12 installments per plan
**Cleanup:** Consider implementing plan expiry/cleanup

---

## Gas Optimization

### Storage Optimization

**Efficient data structures:**
- Use u32 for counters (not u64)
- Use i128 for amounts (Stellar native)
- Avoid nested Vecs

**Storage tiering:**
- Instance: Counter (cheap, ephemeral)
- Persistent: Plans (expensive, permanent)

### Computation Optimization

**Minimize loops:**
- `all()` iterator short-circuits on false
- Index-based access for installments

**Batch operations:**
- Single storage write per plan update
- Single event emission per action

### Call Optimization

**Minimize external calls:**
- Single `get_balance()` call per collection
- Calculate shares once, use multiple times

---

## Future Enhancements

### Potential Features

1. **Early payment discount:** Reduce total if paid early
2. **Late payment penalty:** Increase amount if overdue
3. **Partial payments:** Allow paying portion of installment
4. **Plan modification:** Change due dates or amounts
5. **Grace period:** Allow X days past due before default
6. **Automatic retries:** Retry failed collections N times

### Scalability

**Current limits:**
- 12 installments per plan
- No limit on plans per user
- No global plan limit

**Recommendations:**
- Monitor storage costs
- Consider pagination for `get_user_plans`
- Implement plan archiving after completion

---

## Testing Strategy

### Mock Buffer Contract

All unit and integration tests use a **MockBuffer** implementation that simulates the Buffer Contract behavior without requiring DeFindex or actual deployment.

**Mock Characteristics:**
- Simplified 1:1 share-to-token ratio (1 share = 1 token)
- In-memory state management
- No DeFindex vault integration
- Sufficient for testing Bridge logic in isolation

**Location:** Tests are included at the end of `src/lib.rs` within a `#[cfg(test)]` module.

**Running Tests:**
```bash
cd contracts/soroban/bridge
cargo test
```

### Real Integration Testing

Once the Buffer Contract is deployed with DeFindex integration:

1. Deploy Buffer to testnet with DeFindex vault
2. Deploy Bridge to testnet
3. Configure Bridge with Buffer address
4. Run manual integration tests
5. Verify real share-to-token conversions
6. Test yield accrual scenarios

---
## Testing Checklist

### Unit Tests (Implemented)

- [x] Plan creation with valid inputs
- [x] Plan creation with invalid inputs (each error)
- [x] Installment collection from Available
- [x] Installment collection from Protected
- [x] Installment collection failure → default
- [x] Plan completion → unlock
- [x] Multiple plans per user
- [x] Edge cases (remainder distribution)

### Integration Tests (With Mock Buffer)

- [x] Full flow: create → collect all → complete
- [x] Multi-plan scenarios
- [x] Buffer integration (mock)
- [x] Event emissions
- [x] Error propagation

### Real Integration Tests (Pending Buffer + DeFindex deployment)

- [ ] Deploy Buffer to testnet
- [ ] Deploy Bridge to testnet
- [ ] Test full flow on testnet
- [ ] Verify DeFindex yield integration
- [ ] Load test with realistic data

### Load Tests (Post-MVP)

- [ ] 100 plans per user
- [ ] 12 installments per plan
- [ ] Concurrent collections

---

## Appendix

### Contract Dependencies

```toml
[dependencies]
soroban-sdk = "22.0.0"
```

### Soroban SDK Version

Tested with SDK 22.0.0 (compatible with OpenZeppelin 0.6.0)

### Network Compatibility

- ✅ Testnet (soroban-testnet.stellar.org)
- ✅ Futurenet
- ⏳ Mainnet (pending deployment)

---

*Technical Documentation - Bridge Contract*
*REDI Project - February 2026*