#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, Address, Env, String, Vec, Symbol,
    symbol_short, log,
};

// ============ TYPES ============

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Plan(String),           // Plan por plan_id
    UserPlans(Address),     // Lista de planes de un usuario
    PlanCounter,            // Contador para IDs únicos
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum PlanStatus {
    Active,
    Completed,
    Defaulted,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum InstallmentStatus {
    Pending,
    Paid,
    Failed,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum PaymentSource {
    Available,
    Protected,
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
    pub plan_id: String,
    pub user: Address,
    pub merchant: Address,
    pub total_amount: i128,
    pub installments_count: u32,
    pub installments: Vec<Installment>,
    pub protected_amount: i128,
    pub status: PlanStatus,
    pub created_at: u64,
}

#[contracttype]
#[derive(Clone)]
pub struct BufferBalance {
    pub available: i128,
    pub protected: i128,
    pub total: i128,
}

// ============ ERRORS ============

#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(u32)]
pub enum Error {
    InvalidAmount = 1,
    InvalidInstallments = 2,
    InsufficientCollateral = 3,
    InsufficientAvailable = 4,
    DatesMismatch = 5,
    InvalidDueDate = 6,
    PlanNotFound = 7,
    InstallmentNotFound = 8,
    AlreadyPaid = 9,
    NotDueYet = 10,
    InsufficientFunds = 11,
    TooManyInstallments = 12,
}

// ============ BUFFER CONTRACT CLIENT ============

mod buffer_contract {
    use super::*;
    
    soroban_sdk::contractclient!(
        pub trait BufferContract {
            fn get_balance(user: Address) -> BufferBalance;
            fn lock_protected(user: Address, amount: i128);
            fn unlock_protected(user: Address, amount: i128);
            fn debit_available(user: Address, amount: i128);
            fn debit_protected(user: Address, amount: i128);
        }
    );
}

// ============ CONTRACT ============

#[contract]
pub struct BridgeContract;

#[contractimpl]
impl BridgeContract {
    
    /// Crear un plan de cuotas
    pub fn create_plan(
        env: Env,
        user: Address,
        merchant: Address,
        total_amount: i128,
        installments_count: u32,
        due_dates: Vec<u64>,
        buffer_contract: Address,
    ) -> Result<String, Error> {
        
        // 1. Autenticación
        user.require_auth();
        
        // 2. Validaciones básicas
        if total_amount <= 0 {
            log!(&env, "Error: Invalid amount {}", total_amount);
            return Err(Error::InvalidAmount);
        }
        
        if installments_count == 0 || installments_count > 12 {
            log!(&env, "Error: Invalid installments count {}", installments_count);
            return Err(Error::InvalidInstallments);
        }
        
        if due_dates.len() != installments_count {
            log!(&env, "Error: Dates mismatch {} != {}", due_dates.len(), installments_count);
            return Err(Error::DatesMismatch);
        }
        
        // 3. Validar fechas en el futuro
        let current_time = env.ledger().timestamp();
        for i in 0..due_dates.len() {
            let date = due_dates.get(i).unwrap();
            if date <= current_time {
                log!(&env, "Error: Invalid due date {}", date);
                return Err(Error::InvalidDueDate);
            }
        }
        
        // 4. Consultar Buffer
        let buffer_client = buffer_contract::Client::new(&env, &buffer_contract);
        let balance = buffer_client.get_balance(&user);
        
        // 5. VALIDACIÓN CRÍTICA: Colateralización
        if total_amount > balance.total {
            log!(&env, "Error: Insufficient collateral {} > {}", total_amount, balance.total);
            return Err(Error::InsufficientCollateral);
        }
        
        if total_amount > balance.available {
            log!(&env, "Error: Insufficient available {} > {}", total_amount, balance.available);
            return Err(Error::InsufficientAvailable);
        }
        
        // 6. Generar plan_id único
        let counter: u64 = env.storage()
            .instance()
            .get(&DataKey::PlanCounter)
            .unwrap_or(0);
        
        let plan_id = String::from_str(&env, &format!("plan_{}", counter));
        
        env.storage()
            .instance()
            .set(&DataKey::PlanCounter, &(counter + 1));
        
        // 7. Calcular cuotas
        let amount_per_installment = total_amount / installments_count as i128;
        let remainder = total_amount % installments_count as i128;
        
        let mut installments = Vec::new(&env);
        
        for i in 0..installments_count {
            let mut amount = amount_per_installment;
            
            // Última cuota lleva el remainder
            if i == installments_count - 1 {
                amount += remainder;
            }
            
            installments.push_back(Installment {
                number: i + 1,
                amount,
                due_date: due_dates.get(i).unwrap(),
                paid_at: None,
                payment_source: None,
                status: InstallmentStatus::Pending,
            });
        }
        
        // 8. Crear plan
        let plan = BridgePlan {
            plan_id: plan_id.clone(),
            user: user.clone(),
            merchant,
            total_amount,
            installments_count,
            installments,
            protected_amount: total_amount,
            status: PlanStatus::Active,
            created_at: current_time,
        };
        
        // 9. BLOQUEAR GARANTÍA en Buffer Contract
        buffer_client.lock_protected(&user, &total_amount);
        
        // 10. Guardar plan
        env.storage()
            .persistent()
            .set(&DataKey::Plan(plan_id.clone()), &plan);
        
        // 11. Agregar a lista de planes del usuario
        let mut user_plans: Vec<String> = env.storage()
            .persistent()
            .get(&DataKey::UserPlans(user.clone()))
            .unwrap_or(Vec::new(&env));
        
        user_plans.push_back(plan_id.clone());
        
        env.storage()
            .persistent()
            .set(&DataKey::UserPlans(user.clone()), &user_plans);
        
        // 12. Emitir evento
        env.events().publish((
            symbol_short!("plan_new"),
            plan_id.clone(),
            user,
            total_amount,
        ));
        
        log!(&env, "Bridge plan created: {}", plan_id);
        
        Ok(plan_id)
    }
    
    /// Consultar un plan
    pub fn get_plan(env: Env, plan_id: String) -> Result<BridgePlan, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Plan(plan_id))
            .ok_or(Error::PlanNotFound)
    }
    
    /// Obtener planes de un usuario
    pub fn get_user_plans(env: Env, user: Address) -> Vec<String> {
        env.storage()
            .persistent()
            .get(&DataKey::UserPlans(user))
            .unwrap_or(Vec::new(&env))
    }
    
    /// Cobrar una cuota (llamado por worker)
    pub fn collect_installment(
        env: Env,
        plan_id: String,
        installment_number: u32,
        buffer_contract: Address,
    ) -> Result<PaymentSource, Error> {
        
        // 1. Obtener plan
        let mut plan: BridgePlan = env.storage()
            .persistent()
            .get(&DataKey::Plan(plan_id.clone()))
            .ok_or(Error::PlanNotFound)?;
        
        // 2. Autenticación
        plan.user.require_auth();
        
        // 3. Buscar cuota
        let installment_index = (installment_number - 1) as usize;
        
        if installment_index >= plan.installments.len() {
            log!(&env, "Error: Installment not found {}", installment_number);
            return Err(Error::InstallmentNotFound);
        }
        
        let mut installment = plan.installments.get(installment_index).unwrap();
        
        // 4. Validar estado
        if installment.status != InstallmentStatus::Pending {
            log!(&env, "Error: Installment already paid {}", installment_number);
            return Err(Error::AlreadyPaid);
        }
        
        let current_time = env.ledger().timestamp();
        
        if current_time < installment.due_date {
            log!(&env, "Error: Installment not due yet {}", installment_number);
            return Err(Error::NotDueYet);
        }
        
        // 5. Intentar cobrar
        let buffer_client = buffer_contract::Client::new(&env, &buffer_contract);
        let balance = buffer_client.get_balance(&plan.user);
        
        let amount = installment.amount;
        
        let payment_source = if balance.available >= amount {
            // Cobrar desde Available
            buffer_client.debit_available(&plan.user, &amount);
            log!(&env, "Collected from Available: {}", amount);
            PaymentSource::Available
        } else if balance.protected >= amount {
            // Fallback: Cobrar desde Protected
            buffer_client.debit_protected(&plan.user, &amount);
            log!(&env, "Collected from Protected: {}", amount);
            PaymentSource::Protected
        } else {
            // No hay fondos suficientes
            log!(&env, "Error: Insufficient funds for installment {}", installment_number);
            installment.status = InstallmentStatus::Failed;
            plan.status = PlanStatus::Defaulted;
            
            // Guardar estado
            plan.installments.set(installment_index, installment);
            env.storage().persistent().set(&DataKey::Plan(plan_id), &plan);
            
            return Err(Error::InsufficientFunds);
        };
        
        // 6. Actualizar cuota
        installment.paid_at = Some(current_time);
        installment.payment_source = Some(payment_source.clone());
        installment.status = InstallmentStatus::Paid;
        
        plan.installments.set(installment_index, installment);
        
        // 7. Verificar si plan completado
        let all_paid = (0..plan.installments.len()).all(|i| {
            plan.installments.get(i).unwrap().status == InstallmentStatus::Paid
        });
        
        if all_paid {
            plan.status = PlanStatus::Completed;
            
            // Desbloquear Protected
            buffer_client.unlock_protected(&plan.user, &plan.protected_amount);
            
            log!(&env, "Plan completed: {}", plan_id);
        }
        
        // 8. Guardar plan
        env.storage().persistent().set(&DataKey::Plan(plan_id.clone()), &plan);
        
        // 9. Emitir evento
        env.events().publish((
            symbol_short!("inst_paid"),
            plan_id,
            installment_number,
            payment_source.clone(),
        ));
        
        Ok(payment_source)
    }
    
    /// Obtener próxima cuota vencida de un plan
    pub fn get_next_due(env: Env, plan_id: String) -> Result<Option<Installment>, Error> {
        let plan: BridgePlan = env.storage()
            .persistent()
            .get(&DataKey::Plan(plan_id))
            .ok_or(Error::PlanNotFound)?;
        
        let current_time = env.ledger().timestamp();
        
        for i in 0..plan.installments.len() {
            let installment = plan.installments.get(i).unwrap();
            if installment.status == InstallmentStatus::Pending 
                && installment.due_date <= current_time {
                return Ok(Some(installment));
            }
        }
        
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    #[test]
    fn test_create_plan_basic() {
        let env = Env::default();
        let contract_id = env.register_contract(None, BridgeContract);
        let client = BridgeContractClient::new(&env, &contract_id);
        
        let user = Address::generate(&env);
        let merchant = Address::generate(&env);
        let buffer_contract = Address::generate(&env);
        
        // Este test requiere mock del buffer contract
        // Ver archivo REDI-OpenZeppelin-Prompts.md para tests completos
    }
}
