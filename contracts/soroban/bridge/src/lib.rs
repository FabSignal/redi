#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contractclient, Address, Env, String, Vec,
    symbol_short, log, Error as SorobanError,
};

// ============ DATA TYPES ============

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Plan(String),           // Plan identified by plan_id
    UserPlans(Address),     // List of plans for a user
    PlanCounter,            // Counter to generate unique IDs
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum PlanStatus {
    Active,      // Active plan with pending installments
    Completed,   // Plan completed - all installments paid
    Defaulted,   // Plan in default - some installment failed
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum InstallmentStatus {
    Pending,  // Installment pending payment
    Paid,     // Installment paid successfully
    Failed,   // Installment failed due to lack of funds
}

// ============================================================
// TECHNICAL NOTE: PaymentSource implementation
// ============================================================
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PaymentSource(pub u32);

impl PaymentSource {
    pub fn available() -> Self {
        Self(0)
    }
    
    pub fn protected() -> Self {
        Self(1)
    }
    
    pub fn is_available(&self) -> bool {
        self.0 == 0
    }
    
    pub fn is_protected(&self) -> bool {
        self.0 == 1
    }
    
    pub fn to_u32(&self) -> u32 {
        self.0
    }
}

#[contracttype]
#[derive(Clone)]
pub struct Installment {
    pub number: u32,
    pub amount: i128,
    pub due_date: u64,
    pub paid_at: Option<u64>,
    pub payment_source: Option<PaymentSource>,
    pub status: InstallmentStatus,
}

#[contracttype]
#[derive(Clone)]
pub struct BridgePlan {
    pub plan_id: String,             // Unique plan ID
    pub user: Address,               // User who created the plan
    pub merchant: Address,           // Merchant who receives payments
    pub total_amount: i128,          // Total plan amount in tokens
    pub total_shares: i128,          // Total shares locked as collateral
    pub installments_count: u32,     // Number of installments
    pub installments: Vec<Installment>, // List of plan installments
    pub protected_shares: i128,      // Shares currently protected (decreasing)
    pub status: PlanStatus,          // Current plan status
    pub created_at: u64,             // Creation timestamp
}

// ============ BUFFER CONTRACT INTERFACE ============

#[contracttype]
#[derive(Clone)]
pub struct BufferBalance {
    pub available_shares: i128,    // Shares available for use
    pub protected_shares: i128,    // Shares locked as collateral
    pub total_deposited: i128,     // Total deposited historically
    pub last_deposit_ts: u64,      // Timestamp of last deposit
    pub version: u64,              // Balance version
}

#[contracttype]
#[derive(Clone)]
pub struct LockResult {
    pub shares_locked: i128,       // Amount of shares that were locked
    pub new_available: i128,       // New balance of available shares
    pub new_protected: i128,       // New balance of protected shares
}

#[contracttype]
#[derive(Clone)]
pub struct WithdrawResult {
    pub shares_burned: i128,            // Shares burned in the operation
    pub amounts_received: Vec<i128>,    // Amounts received per asset
    pub new_available_balance: i128,    // New available balance
    pub from_protected: bool,           // Whether debited from protected
}

// Client to call Buffer Contract functions
#[contractclient(name = "BufferContractClient")]
pub trait BufferContract {
    // Get user balance
    fn get_balance(env: Env, user: Address) -> BufferBalance;
    
    // Lock shares as collateral
    fn lock_shares(env: Env, user: Address, shares: i128) -> LockResult;
    
    // Unlock shares (release collateral)
    fn unlock_shares(env: Env, user: Address, shares: i128) -> LockResult;
    
    // Debit from available shares
    fn debit_available(env: Env, user: Address, shares: i128, to: Address) -> WithdrawResult;
    
    // Debit from protected shares (fallback)
    fn debit_protected(env: Env, user: Address, shares: i128, to: Address) -> WithdrawResult;
    
    // Get values in tokens (available, protected, total)
    fn get_values(env: Env, user: Address) -> (i128, i128, i128);
    
    // Calculate shares needed for a token amount
    fn shares_for_amount(env: Env, amount: i128) -> i128;
}

// ============ COLLATERALIZATION CONSTANTS ============

/// Maximum Loan-to-Value ratio in basis points (10000 = 100%)
/// 8000 = 80% - Plan can use up to 80% of total Buffer value
const MAX_LTV_BPS: i128 = 8000;

/// Liquidation threshold in basis points (for future alerts)
/// 8500 = 85% - Point where risk should be alerted
const LIQUIDATION_THRESHOLD_BPS: i128 = 8500;

// ============ ERRORS ============

#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(u32)]
pub enum ContractError {
    InvalidAmount = 1,           // Invalid or negative amount
    InvalidInstallments = 2,     // Invalid installment quantity (0 or >12)
    InsufficientCollateral = 3,  // Total buffer less than requested amount
    InsufficientAvailable = 4,   // Insufficient available buffer to lock
    DatesMismatch = 5,           // Number of dates does not match installments
    InvalidDueDate = 6,          // Due date in the past
    PlanNotFound = 7,            // Plan not found in storage
    InstallmentNotFound = 8,     // Installment not found in plan
    AlreadyPaid = 9,             // Installment already paid
    NotDueYet = 10,              // Installment not yet due
    InsufficientFunds = 11,      // Insufficient funds to pay installment
    TooManyInstallments = 12,    // More than 12 installments requested
    BufferContractError = 13,    // Error calling Buffer Contract
    InvalidShares = 14,          // Invalid shares calculation
    ExceedsMaxLTV = 15,          // Plan exceeds maximum Loan-to-Value ratio
}

// Conversion of our error to SorobanError
impl From<ContractError> for SorobanError {
    fn from(e: ContractError) -> Self {
        SorobanError::from_contract_error(e as u32)
    }
}

impl From<&ContractError> for SorobanError {
    fn from(e: &ContractError) -> Self {
        SorobanError::from_contract_error(*e as u32)
    }
}

// Conversion of SorobanError to our error (catch-all)
impl From<SorobanError> for ContractError {
    fn from(_: SorobanError) -> Self {
        ContractError::BufferContractError
    }
}

// ============ MAIN CONTRACT ============

#[contract]
pub struct BridgeContract;

#[contractimpl]
impl BridgeContract {
    
    /// Create an installment plan
    /// 
    /// Creates a new installment financing plan, locking Buffer shares
    /// as collateral. Validates that the user has sufficient collateral
    /// and locks the necessary shares.
    pub fn create_plan(
        env: Env,
        user: Address,               // User who creates the plan
        merchant: Address,           // Merchant who will receive payments
        total_amount: i128,          // Total amount to finance
        installments_count: u32,     // Number of installments (1-12)
        due_dates: Vec<u64>,         // Due dates of each installment
        buffer_contract: Address,    // Address of Buffer Contract
    ) -> Result<String, ContractError> {
        
        // Verify that user signed the transaction
        user.require_auth();
        
        // ===== BASIC VALIDATIONS =====
        
        if total_amount <= 0 {
            log!(&env, "Error: Invalid amount {}", total_amount);
            return Err(ContractError::InvalidAmount);
        }
        
        if installments_count == 0 || installments_count > 12 {
            log!(&env, "Error: Invalid installment quantity {}", installments_count);
            return Err(ContractError::InvalidInstallments);
        }
        
        if due_dates.len() != installments_count {
            log!(&env, "Error: Number of dates {} does not match installments {}", 
                due_dates.len(), installments_count);
            return Err(ContractError::DatesMismatch);
        }
        
        // Validate that all dates are in the future
        let current_time = env.ledger().timestamp();
        for i in 0..due_dates.len() {
            let date = due_dates.get(i).unwrap();
            if date <= current_time {
                log!(&env, "Error: Due date in the past {}", date);
                return Err(ContractError::InvalidDueDate);
            }
        }
        
        // ===== QUERY BUFFER AND VALIDATE COLLATERALIZATION =====
        
        let buffer_client = BufferContractClient::new(&env, &buffer_contract);
        
        // Get values in tokens for validation
        let (available_value, _, total_value) = buffer_client.get_values(&user);
        
        // ===== LTV VALIDATION: Calculate maximum allowed amount =====
        // MAX_LTV_BPS = 8000 means 80%
        // max_bridge_amount = total_value * 80 / 100 = total_value * 0.8
        let max_bridge_amount = (total_value * MAX_LTV_BPS) / 10000;
        
        log!(&env, "Total Buffer: {}, Max allowed (LTV 80%): {}, Requested: {}", 
            total_value, max_bridge_amount, total_amount);
        
        // Validate plan doesn't exceed maximum LTV
        if total_amount > max_bridge_amount {
            log!(&env, "Error: Plan exceeds max LTV {} > {}", total_amount, max_bridge_amount);
            return Err(ContractError::ExceedsMaxLTV);
        }
        
        // Validate that there is sufficient available to lock
        if total_amount > available_value {
            log!(&env, "Error: Insufficient available balance {} > {}", 
                total_amount, available_value);
            return Err(ContractError::InsufficientAvailable);
        }
        
        // Calculate how many shares need to be locked
        let shares_needed = buffer_client.shares_for_amount(&total_amount);
        
        if shares_needed <= 0 {
            log!(&env, "Error: Invalid shares calculation");
            return Err(ContractError::InvalidShares);
        }
        
        // ===== LOCK SHARES IN BUFFER =====
        
        let _lock_result = buffer_client.lock_shares(&user, &shares_needed);
        
        // ===== GENERATE UNIQUE PLAN ID =====
        
        let counter: u64 = env.storage()
            .instance()
            .get(&DataKey::PlanCounter)
            .unwrap_or(0);
        
        // Create ID from bytes (avoids issues with to_string())
        let mut id_bytes = [0u8; 16];
        id_bytes[0..8].copy_from_slice(&counter.to_be_bytes());
        let plan_id = String::from_bytes(&env, &id_bytes);
        
        // Increment counter for next plan
        env.storage()
            .instance()
            .set(&DataKey::PlanCounter, &(counter + 1));
        
        // ===== CALCULATE INSTALLMENTS =====
        
        // Divide total amount into equal installments
        let amount_per_installment = total_amount / installments_count as i128;
        let remainder = total_amount % installments_count as i128;
        
        let mut installments: Vec<Installment> = Vec::new(&env);
        
        for i in 0..installments_count {
            let mut amount = amount_per_installment;
            
            // The last installment carries the remainder to complete the exact total
            if i == installments_count - 1 {
                amount += remainder;
            }
            
            let installment = Installment {
                number: i + 1,
                amount,
                due_date: due_dates.get(i).unwrap(),
                paid_at: None,
                payment_source: None,
                status: InstallmentStatus::Pending,
            };
            
            installments.push_back(installment);
        }
        
        // Clone merchant to use it twice
        let merchant_for_plan = merchant.clone();
        
        // ===== CREATE AND SAVE PLAN =====
        
        let plan = BridgePlan {
            plan_id: plan_id.clone(),
            user: user.clone(),
            merchant: merchant_for_plan,
            total_amount,
            total_shares: shares_needed,
            installments_count,
            installments: installments.clone(),
            protected_shares: shares_needed,  // Initially all shares are protected
            status: PlanStatus::Active,
            created_at: current_time,
        };
        
        // Save plan in persistent storage
        env.storage()
            .persistent()
            .set(&DataKey::Plan(plan_id.clone()), &plan);
        
        // Add plan to user's plan list
        let mut user_plans: Vec<String> = env.storage()
            .persistent()
            .get(&DataKey::UserPlans(user.clone()))
            .unwrap_or(Vec::new(&env));
        
        user_plans.push_back(plan_id.clone());
        
        env.storage()
            .persistent()
            .set(&DataKey::UserPlans(user.clone()), &user_plans);
        
        // ===== EMIT EVENT =====
        
        env.events().publish((
            symbol_short!("plan_new"),
            plan_id.clone(),
            user,
            merchant,
            total_amount,
            installments_count,
            shares_needed,
        ), ());
        
        log!(&env, "Bridge plan created with {} shares locked", shares_needed);
        
        Ok(plan_id)
    }
    
    /// Query a plan by its ID
    pub fn get_plan(env: Env, plan_id: String) -> Result<BridgePlan, ContractError> {
        env.storage()
            .persistent()
            .get(&DataKey::Plan(plan_id))
            .ok_or(ContractError::PlanNotFound)
    }
    
    /// Get all plans for a user
    pub fn get_user_plans(env: Env, user: Address) -> Vec<String> {
        env.storage()
            .persistent()
            .get(&DataKey::UserPlans(user))
            .unwrap_or(Vec::new(&env))
    }
    
    /// Collect an installment (called by automatic worker)
    /// 
    /// Attempts to collect an overdue installment. First tries from available shares,
    /// if insufficient falls back to protected shares. If still insufficient,
    /// marks the installment failed and plan as defaulted.
    pub fn collect_installment(
        env: Env,
        plan_id: String,             // Plan ID
        installment_number: u32,     // Installment number to collect
        buffer_contract: Address,    // Buffer Contract address
        merchant_address: Address,   // Merchant address (receives payment)
    ) -> Result<PaymentSource, ContractError> {
        
        // ===== GET AND VALIDATE PLAN =====
        
        let mut plan: BridgePlan = env.storage()
            .persistent()
            .get(&DataKey::Plan(plan_id.clone()))
            .ok_or(ContractError::PlanNotFound)?;
        
        // Verify user authentication
        plan.user.require_auth();
        
        // Search for installment in plan
        let installment_index = installment_number - 1;
        
        if installment_index >= plan.installments.len() {
            log!(&env, "Error: Installment not found {}", installment_number);
            return Err(ContractError::InstallmentNotFound);
        }
        
        let mut installment = plan.installments.get(installment_index).unwrap();
        
        // Validate that installment is pending
        if installment.status != InstallmentStatus::Pending {
            log!(&env, "Error: Installment already paid {}", installment_number);
            return Err(ContractError::AlreadyPaid);
        }
        
        // Validate that installment is due
        let current_time = env.ledger().timestamp();
        
        if current_time < installment.due_date {
            log!(&env, "Error: Installment not yet due {}", installment_number);
            return Err(ContractError::NotDueYet);
        }
        
        // ===== CALCULATE NEEDED SHARES AND GET BALANCE =====
        
        let buffer_client = BufferContractClient::new(&env, &buffer_contract);
        let shares_needed = buffer_client.shares_for_amount(&installment.amount);
        let balance = buffer_client.get_balance(&plan.user);
        
        // ===== ATTEMPT COLLECTION (Available first, Protected as fallback) =====
        
        let payment_source = if balance.available_shares >= shares_needed {
            
            // CASE 1: Collect from available shares
            buffer_client.debit_available(&plan.user, &shares_needed, &merchant_address);
            
            // Update protected shares proportionally
            if plan.total_amount > 0 {
                let shares_to_unlock = (shares_needed as i128)
                    .checked_mul(plan.total_shares)
                    .unwrap_or(0)
                    .checked_div(plan.total_amount)
                    .unwrap_or(0);
                
                plan.protected_shares = plan.protected_shares.checked_sub(shares_to_unlock)
                    .unwrap_or(0);
            }
            
            log!(&env, "Collected from Available: {} shares", shares_needed);
            PaymentSource::available()
            
        } else if balance.protected_shares >= shares_needed {
            
            // CASE 2: Fallback - Collect from protected shares
            buffer_client.debit_protected(&plan.user, &shares_needed, &merchant_address);
            
            // Reduce plan's protected shares
            plan.protected_shares = plan.protected_shares.checked_sub(shares_needed)
                .unwrap_or_else(|| {
                    log!(&env, "Error: Shares protegidos insuficientes");
                    0
                });
            
            log!(&env, "Collected from Protected: {} shares", shares_needed);
            PaymentSource::protected() 
            
        } else {
            
            // CASE 3: Insufficient funds - Mark as failed
            log!(&env, "Error: Insufficient funds for installment {}", installment_number);
            installment.status = InstallmentStatus::Failed;
            plan.status = PlanStatus::Defaulted;
            
            plan.installments.set(installment_index, installment);
            env.storage().persistent().set(&DataKey::Plan(plan_id), &plan);
            
            return Err(ContractError::InsufficientFunds);
        };
        
        // ===== UPDATE INSTALLMENT STATUS =====
        
        installment.paid_at = Some(current_time);
        installment.payment_source = Some(payment_source);
        installment.status = InstallmentStatus::Paid;
        
        plan.installments.set(installment_index, installment);
        
        // ===== CHECK IF PLAN IS COMPLETE =====
        
        let all_paid = (0..plan.installments.len()).all(|i| {
            plan.installments.get(i).unwrap().status == InstallmentStatus::Paid
        });
        
        if all_paid {
            plan.status = PlanStatus::Completed;
            
            // Release remaining protected shares (if any)
            if plan.protected_shares > 0 {
                buffer_client.unlock_shares(&plan.user, &plan.protected_shares);
                log!(&env, "Released {} remaining shares", plan.protected_shares);
                plan.protected_shares = 0;
            }
        }
        
        // ===== SAVE UPDATED PLAN =====
        
        env.storage().persistent().set(&DataKey::Plan(plan_id.clone()), &plan);
        
        // ===== EMITIR EVENTO =====
        
        env.events().publish((
            symbol_short!("inst_paid"),
            plan_id,
            installment_number,
            payment_source,
            shares_needed,
        ), ());
        
        Ok(payment_source)
    }
    
    /// Get the next due installment of a plan
    /// 
    /// Searches for the first installment that is pending and already due.
    /// Useful for automatic workers that process collections.
    pub fn get_next_due(env: Env, plan_id: String) -> Result<Option<Installment>, ContractError> {
        let plan: BridgePlan = env.storage()
            .persistent()
            .get(&DataKey::Plan(plan_id))
            .ok_or(ContractError::PlanNotFound)?;
        
        let current_time = env.ledger().timestamp();
        
        // Search for first pending and due installment
        for i in 0..plan.installments.len() {
            let installment = plan.installments.get(i).unwrap();
            if installment.status == InstallmentStatus::Pending 
                && installment.due_date <= current_time {
                return Ok(Some(installment));
            }
        }
        
        // No due installments
        Ok(None)
    }
    
    /// Get complete plan summary with updated Buffer values
    /// 
    /// Returns the plan along with the current token values of the user's Buffer
    /// (available and protected). Useful for displaying in UI.
    pub fn get_plan_summary(
        env: Env, 
        plan_id: String, 
        buffer_contract: Address
    ) -> Result<(BridgePlan, i128, i128), ContractError> {
        let plan = Self::get_plan(env.clone(), plan_id)?;
        
        let buffer_client = BufferContractClient::new(&env, &buffer_contract);
        let (available_value, protected_value, _total_value) = buffer_client.get_values(&plan.user);
        
        // Returns: (plan, available_value, protected_value)
        Ok((plan, available_value, protected_value))
    }

    }

// ============ TESTS WITH MOCK BUFFER ============


#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, testutils::Ledger, Env, Vec as SorobanVec};
    
    // Simple MOCK without complex types
    #[contract]
    pub struct MockBuffer;

    #[contractimpl]
    impl MockBuffer {
        pub fn get_balance(_env: Env, _user: Address) -> (i128, i128, i128) {
            (10000, 0, 10000) // (available, protected, total)
        }

        pub fn lock_shares(_env: Env, _user: Address, shares: i128) -> (i128, i128, i128) {
            (shares, 10000 - shares, shares)
        }

        pub fn unlock_shares(_env: Env, _user: Address, shares: i128) -> (i128, i128, i128) {
            (shares, 10000 + shares, 0)
        }

        pub fn debit_available(_env: Env, _user: Address, shares: i128, _to: Address) -> (i128, i128, bool) {
            (shares, 10000 - shares, false)
        }

        pub fn debit_protected(_env: Env, _user: Address, shares: i128, _to: Address) -> (i128, i128, bool) {
            (shares, 10000, true)
        }

        pub fn get_values(_env: Env, _user: Address) -> (i128, i128, i128) {
            (10000, 0, 10000)
        }

        pub fn shares_for_amount(_env: Env, amount: i128) -> i128 {
            amount
        }
    }

    pub struct TestContext {
        pub env: Env,
        pub user: Address,
        pub merchant: Address,
        pub buffer: Address,
        pub bridge: Address,
    }

    impl TestContext {
        pub fn new() -> Self {
            let env = Env::default();
            env.mock_all_auths();
            env.ledger().set_timestamp(1000);

            let buffer = env.register(MockBuffer, ());
            let bridge = env.register(BridgeContract, ());

            Self {
                env: env.clone(),
                user: Address::generate(&env),
                merchant: Address::generate(&env),
                buffer,
                bridge,
            }
        }

        pub fn client(&self) -> BridgeContractClient {
            BridgeContractClient::new(&self.env, &self.bridge)
        }

        pub fn advance_time(&self, seconds: u64) {
            self.env.ledger().set_timestamp(self.env.ledger().timestamp() + seconds);
        }
    }

    #[test]
    fn test_create_plan_basic() {
        let ctx = TestContext::new();
        let client = ctx.client();

        let due_dates = SorobanVec::from_array(&ctx.env, [2000u64, 3000, 4000]);
        let plan_id = client.create_plan(&ctx.user, &ctx.merchant, &3000, &3, &due_dates, &ctx.buffer);
        let plan = client.get_plan(&plan_id);

        assert_eq!(plan.user, ctx.user);
        assert_eq!(plan.merchant, ctx.merchant);
        assert_eq!(plan.total_amount, 3000);
        assert_eq!(plan.installments.len(), 3);
    }

    #[test]
    fn test_full_lifecycle() {
        let ctx = TestContext::new();
        let client = ctx.client();

        let due_dates = SorobanVec::from_array(&ctx.env, [2000u64, 3000, 4000]);
        let plan_id = client.create_plan(&ctx.user, &ctx.merchant, &3000, &3, &due_dates, &ctx.buffer);

        ctx.advance_time(1500);
        let source = client.collect_installment(&plan_id, &1, &ctx.buffer, &ctx.merchant);
        assert_eq!(source.to_u32(), 0);

        ctx.advance_time(1000);
        client.collect_installment(&plan_id, &2, &ctx.buffer, &ctx.merchant);

        ctx.advance_time(1000);
        client.collect_installment(&plan_id, &3, &ctx.buffer, &ctx.merchant);

        let final_plan = client.get_plan(&plan_id);
        assert_eq!(final_plan.status, PlanStatus::Completed);
    }

    #[test]
    fn test_ltv_max_allowed() {
        let ctx = TestContext::new();
        let client = ctx.client();

        // Buffer total = 10000, LTV 80% = 8000 maximum allowed
        let due_dates = SorobanVec::from_array(&ctx.env, [2000u64, 3000, 4000]);
        let plan_id = client.create_plan(&ctx.user, &ctx.merchant, &8000, &3, &due_dates, &ctx.buffer);
        let plan = client.get_plan(&plan_id);

        assert_eq!(plan.total_amount, 8000);
        assert_eq!(plan.status, PlanStatus::Active);
    }

    #[test]
    #[should_panic(expected = "Status(ContractError(15))")] // ExceedsMaxLTV
    fn test_ltv_exceeds_maximum() {
        let ctx = TestContext::new();
        let client = ctx.client();

        // Attempt to create plan for 9000 when maximum is 8000 (80% of 10000)
        let due_dates = SorobanVec::from_array(&ctx.env, [2000u64, 3000, 4000]);
        client.create_plan(&ctx.user, &ctx.merchant, &9000, &3, &due_dates, &ctx.buffer);
    }

    #[test]
    #[should_panic(expected = "Status(ContractError(15))")] // ExceedsMaxLTV
    fn test_ltv_at_100_percent_fails() {
        let ctx = TestContext::new();
        let client = ctx.client();

        // Attempting to use 100% of buffer (10000) should fail
        let due_dates = SorobanVec::from_array(&ctx.env, [2000u64, 3000, 4000]);
        client.create_plan(&ctx.user, &ctx.merchant, &10000, &3, &due_dates, &ctx.buffer);
    }
}