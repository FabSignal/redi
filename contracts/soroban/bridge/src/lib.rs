#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contractclient, Address, Env, String, Vec,
    symbol_short, log, Error as SorobanError,
};

// ============ TIPOS DE DATOS ============

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Plan(String),           // Plan identificado por plan_id
    UserPlans(Address),     // Lista de planes de un usuario
    PlanCounter,            // Contador para generar IDs únicos
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum PlanStatus {
    Active,      // Plan activo con cuotas pendientes
    Completed,   // Plan completado - todas las cuotas pagadas
    Defaulted,   // Plan en default - falló alguna cuota
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum InstallmentStatus {
    Pending,  // Cuota pendiente de pago
    Paid,     // Cuota pagada exitosamente
    Failed,   // Cuota falló por falta de fondos
}

// ============================================================
// NOTA TÉCNICA: Implementación de PaymentSource
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
    pub plan_id: String,             // ID único del plan
    pub user: Address,               // Usuario que creó el plan
    pub merchant: Address,           // Comercio que recibe los pagos
    pub total_amount: i128,          // Monto total del plan en tokens
    pub total_shares: i128,          // Total de shares bloqueados como garantía
    pub installments_count: u32,     // Cantidad de cuotas
    pub installments: Vec<Installment>, // Lista de cuotas del plan
    pub protected_shares: i128,      // Shares actualmente protegidos (va disminuyendo)
    pub status: PlanStatus,          // Estado actual del plan
    pub created_at: u64,             // Timestamp de creación
}

// ============ INTERFAZ DEL BUFFER CONTRACT ============

#[contracttype]
#[derive(Clone)]
pub struct BufferBalance {
    pub available_shares: i128,    // Shares disponibles para usar
    pub protected_shares: i128,    // Shares bloqueados como garantía
    pub total_deposited: i128,     // Total depositado históricamente
    pub last_deposit_ts: u64,      // Timestamp del último depósito
    pub version: u64,              // Versión del balance
}

#[contracttype]
#[derive(Clone)]
pub struct LockResult {
    pub shares_locked: i128,       // Cantidad de shares que se bloquearon
    pub new_available: i128,       // Nuevo balance de shares disponibles
    pub new_protected: i128,       // Nuevo balance de shares protegidos
}

#[contracttype]
#[derive(Clone)]
pub struct WithdrawResult {
    pub shares_burned: i128,            // Shares quemados en la operación
    pub amounts_received: Vec<i128>,    // Montos recibidos por asset
    pub new_available_balance: i128,    // Nuevo balance disponible
    pub from_protected: bool,           // Si se debitó desde protegido
}

// Cliente para llamar funciones del Buffer Contract
#[contractclient(name = "BufferContractClient")]
pub trait BufferContract {
    // Obtener balance del usuario
    fn get_balance(env: Env, user: Address) -> BufferBalance;
    
    // Bloquear shares como garantía
    fn lock_shares(env: Env, user: Address, shares: i128) -> LockResult;
    
    // Desbloquear shares (liberar garantía)
    fn unlock_shares(env: Env, user: Address, shares: i128) -> LockResult;
    
    // Debitar desde shares disponibles
    fn debit_available(env: Env, user: Address, shares: i128, to: Address) -> WithdrawResult;
    
    // Debitar desde shares protegidos (fallback)
    fn debit_protected(env: Env, user: Address, shares: i128, to: Address) -> WithdrawResult;
    
    // Obtener valores en tokens (disponible, protegido, total)
    fn get_values(env: Env, user: Address) -> (i128, i128, i128);
    
    // Calcular shares necesarios para un monto en tokens
    fn shares_for_amount(env: Env, amount: i128) -> i128;
}

// ============ ERRORES ============

#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(u32)]
pub enum ContractError {
    InvalidAmount = 1,           // Monto inválido o negativo
    InvalidInstallments = 2,     // Cantidad de cuotas inválida (0 o >12)
    InsufficientCollateral = 3,  // Buffer total menor al monto solicitado
    InsufficientAvailable = 4,   // Buffer disponible insuficiente para bloquear
    DatesMismatch = 5,           // Cantidad de fechas no coincide con cuotas
    InvalidDueDate = 6,          // Fecha de vencimiento en el pasado
    PlanNotFound = 7,            // Plan no encontrado en storage
    InstallmentNotFound = 8,     // Cuota no encontrada en el plan
    AlreadyPaid = 9,             // Cuota ya fue pagada
    NotDueYet = 10,              // Cuota todavía no venció
    InsufficientFunds = 11,      // Fondos insuficientes para pagar cuota
    TooManyInstallments = 12,    // Más de 12 cuotas solicitadas
    BufferContractError = 13,    // Error al llamar al Buffer Contract
    InvalidShares = 14,          // Cálculo de shares inválido
}

// Conversión de nuestro error a SorobanError
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

// Conversión de SorobanError a nuestro error (catch-all)
impl From<SorobanError> for ContractError {
    fn from(_: SorobanError) -> Self {
        ContractError::BufferContractError
    }
}

// ============ CONTRATO PRINCIPAL ============

#[contract]
pub struct BridgeContract;

#[contractimpl]
impl BridgeContract {
    
    /// Crear un plan de cuotas
    /// 
    /// Crea un nuevo plan de financiamiento en cuotas, bloqueando shares
    /// del Buffer como garantía. Valida que el usuario tenga suficiente
    /// colateral y bloquea los shares necesarios.
    pub fn create_plan(
        env: Env,
        user: Address,               // Usuario que crea el plan
        merchant: Address,           // Comercio que recibirá los pagos
        total_amount: i128,          // Monto total a financiar
        installments_count: u32,     // Cantidad de cuotas (1-12)
        due_dates: Vec<u64>,         // Fechas de vencimiento de cada cuota
        buffer_contract: Address,    // Dirección del Buffer Contract
    ) -> Result<String, ContractError> {
        
        // Verificar que el usuario firmó la transacción
        user.require_auth();
        
        // ===== VALIDACIONES BÁSICAS =====
        
        if total_amount <= 0 {
            log!(&env, "Error: Monto inválido {}", total_amount);
            return Err(ContractError::InvalidAmount);
        }
        
        if installments_count == 0 || installments_count > 12 {
            log!(&env, "Error: Cantidad de cuotas inválida {}", installments_count);
            return Err(ContractError::InvalidInstallments);
        }
        
        if due_dates.len() != installments_count {
            log!(&env, "Error: Cantidad de fechas {} no coincide con cuotas {}", 
                due_dates.len(), installments_count);
            return Err(ContractError::DatesMismatch);
        }
        
        // Validar que todas las fechas estén en el futuro
        let current_time = env.ledger().timestamp();
        for i in 0..due_dates.len() {
            let date = due_dates.get(i).unwrap();
            if date <= current_time {
                log!(&env, "Error: Fecha de vencimiento en el pasado {}", date);
                return Err(ContractError::InvalidDueDate);
            }
        }
        
        // ===== CONSULTAR BUFFER Y VALIDAR COLATERALIZACIÓN =====
        
        let buffer_client = BufferContractClient::new(&env, &buffer_contract);
        
        // Obtener valores en tokens para validación
        let (available_value, _, total_value) = buffer_client.get_values(&user);
        
        // Validar que el Buffer total sea >= al monto solicitado
        if total_amount > total_value {
            log!(&env, "Error: Colateral insuficiente {} > {}", total_amount, total_value);
            return Err(ContractError::InsufficientCollateral);
        }
        
        // Validar que haya suficiente disponible para bloquear
        if total_amount > available_value {
            log!(&env, "Error: Balance disponible insuficiente {} > {}", 
                total_amount, available_value);
            return Err(ContractError::InsufficientAvailable);
        }
        
        // Calcular cuántos shares se necesitan bloquear
        let shares_needed = buffer_client.shares_for_amount(&total_amount);
        
        if shares_needed <= 0 {
            log!(&env, "Error: Cálculo de shares inválido");
            return Err(ContractError::InvalidShares);
        }
        
        // ===== BLOQUEAR SHARES EN EL BUFFER =====
        
        let _lock_result = buffer_client.lock_shares(&user, &shares_needed);
        
        // ===== GENERAR ID ÚNICO DEL PLAN =====
        
        let counter: u64 = env.storage()
            .instance()
            .get(&DataKey::PlanCounter)
            .unwrap_or(0);
        
        // Crear ID desde bytes (evita problemas con to_string())
        let mut id_bytes = [0u8; 16];
        id_bytes[0..8].copy_from_slice(&counter.to_be_bytes());
        let plan_id = String::from_bytes(&env, &id_bytes);
        
        // Incrementar contador para el próximo plan
        env.storage()
            .instance()
            .set(&DataKey::PlanCounter, &(counter + 1));
        
        // ===== CALCULAR CUOTAS =====
        
        // Dividir el monto total en cuotas iguales
        let amount_per_installment = total_amount / installments_count as i128;
        let remainder = total_amount % installments_count as i128;
        
        let mut installments: Vec<Installment> = Vec::new(&env);
        
        for i in 0..installments_count {
            let mut amount = amount_per_installment;
            
            // La última cuota lleva el remainder para completar el total exacto
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
        
        // Clonar merchant para poder usarlo dos veces
        let merchant_for_plan = merchant.clone();
        
        // ===== CREAR Y GUARDAR PLAN =====
        
        let plan = BridgePlan {
            plan_id: plan_id.clone(),
            user: user.clone(),
            merchant: merchant_for_plan,
            total_amount,
            total_shares: shares_needed,
            installments_count,
            installments: installments.clone(),
            protected_shares: shares_needed,  // Inicialmente todos los shares están protegidos
            status: PlanStatus::Active,
            created_at: current_time,
        };
        
        // Guardar plan en storage persistente
        env.storage()
            .persistent()
            .set(&DataKey::Plan(plan_id.clone()), &plan);
        
        // Agregar plan a la lista de planes del usuario
        let mut user_plans: Vec<String> = env.storage()
            .persistent()
            .get(&DataKey::UserPlans(user.clone()))
            .unwrap_or(Vec::new(&env));
        
        user_plans.push_back(plan_id.clone());
        
        env.storage()
            .persistent()
            .set(&DataKey::UserPlans(user.clone()), &user_plans);
        
        // ===== EMITIR EVENTO =====
        
        env.events().publish((
            symbol_short!("plan_new"),
            plan_id.clone(),
            user,
            merchant,
            total_amount,
            installments_count,
            shares_needed,
        ), ());
        
        log!(&env, "Plan Bridge creado con {} shares bloqueados", shares_needed);
        
        Ok(plan_id)
    }
    
    /// Consultar un plan por su ID
    pub fn get_plan(env: Env, plan_id: String) -> Result<BridgePlan, ContractError> {
        env.storage()
            .persistent()
            .get(&DataKey::Plan(plan_id))
            .ok_or(ContractError::PlanNotFound)
    }
    
    /// Obtener todos los planes de un usuario
    pub fn get_user_plans(env: Env, user: Address) -> Vec<String> {
        env.storage()
            .persistent()
            .get(&DataKey::UserPlans(user))
            .unwrap_or(Vec::new(&env))
    }
    
    /// Cobrar una cuota (llamado por worker automático)
    /// 
    /// Intenta cobrar una cuota vencida. Primero intenta desde shares disponibles,
    /// si no alcanza hace fallback a shares protegidos. Si tampoco alcanza,
    /// marca la cuota como fallida y el plan como defaulted.
    pub fn collect_installment(
        env: Env,
        plan_id: String,             // ID del plan
        installment_number: u32,     // Número de cuota a cobrar
        buffer_contract: Address,    // Dirección del Buffer Contract
        merchant_address: Address,   // Dirección del comercio (recibe el pago)
    ) -> Result<PaymentSource, ContractError> {
        
        // ===== OBTENER PLAN Y VALIDAR =====
        
        let mut plan: BridgePlan = env.storage()
            .persistent()
            .get(&DataKey::Plan(plan_id.clone()))
            .ok_or(ContractError::PlanNotFound)?;
        
        // Verificar autenticación del usuario
        plan.user.require_auth();
        
        // Buscar la cuota en el plan
        let installment_index = installment_number - 1;
        
        if installment_index >= plan.installments.len() {
            log!(&env, "Error: Cuota no encontrada {}", installment_number);
            return Err(ContractError::InstallmentNotFound);
        }
        
        let mut installment = plan.installments.get(installment_index).unwrap();
        
        // Validar que la cuota esté pendiente
        if installment.status != InstallmentStatus::Pending {
            log!(&env, "Error: Cuota ya fue pagada {}", installment_number);
            return Err(ContractError::AlreadyPaid);
        }
        
        // Validar que la cuota ya venció
        let current_time = env.ledger().timestamp();
        
        if current_time < installment.due_date {
            log!(&env, "Error: Cuota todavía no venció {}", installment_number);
            return Err(ContractError::NotDueYet);
        }
        
        // ===== CALCULAR SHARES NECESARIOS Y OBTENER BALANCE =====
        
        let buffer_client = BufferContractClient::new(&env, &buffer_contract);
        let shares_needed = buffer_client.shares_for_amount(&installment.amount);
        let balance = buffer_client.get_balance(&plan.user);
        
        // ===== INTENTAR COBRAR (Available primero, Protected como fallback) =====
        
        let payment_source = if balance.available_shares >= shares_needed {
            
            // CASO 1: Cobrar desde shares disponibles
            buffer_client.debit_available(&plan.user, &shares_needed, &merchant_address);
            
            // Actualizar shares protegidos proporcionalmente
            if plan.total_amount > 0 {
                let shares_to_unlock = (shares_needed as i128)
                    .checked_mul(plan.total_shares)
                    .unwrap_or(0)
                    .checked_div(plan.total_amount)
                    .unwrap_or(0);
                
                plan.protected_shares = plan.protected_shares.checked_sub(shares_to_unlock)
                    .unwrap_or(0);
            }
            
            log!(&env, "Cobrado desde Available: {} shares", shares_needed);
            PaymentSource::available()
            
        } else if balance.protected_shares >= shares_needed {
            
            // CASO 2: Fallback - Cobrar desde shares protegidos
            buffer_client.debit_protected(&plan.user, &shares_needed, &merchant_address);
            
            // Reducir shares protegidos del plan
            plan.protected_shares = plan.protected_shares.checked_sub(shares_needed)
                .unwrap_or_else(|| {
                    log!(&env, "Error: Shares protegidos insuficientes");
                    0
                });
            
            log!(&env, "Cobrado desde Protected: {} shares", shares_needed);
            PaymentSource::protected() 
            
        } else {
            
            // CASO 3: Fondos insuficientes - Marcar como fallida
            log!(&env, "Error: Fondos insuficientes para cuota {}", installment_number);
            installment.status = InstallmentStatus::Failed;
            plan.status = PlanStatus::Defaulted;
            
            plan.installments.set(installment_index, installment);
            env.storage().persistent().set(&DataKey::Plan(plan_id), &plan);
            
            return Err(ContractError::InsufficientFunds);
        };
        
        // ===== ACTUALIZAR ESTADO DE LA CUOTA =====
        
        installment.paid_at = Some(current_time);
        installment.payment_source = Some(payment_source);
        installment.status = InstallmentStatus::Paid;
        
        plan.installments.set(installment_index, installment);
        
        // ===== VERIFICAR SI EL PLAN SE COMPLETÓ =====
        
        let all_paid = (0..plan.installments.len()).all(|i| {
            plan.installments.get(i).unwrap().status == InstallmentStatus::Paid
        });
        
        if all_paid {
            plan.status = PlanStatus::Completed;
            
            // Liberar shares protegidos restantes (si los hay)
            if plan.protected_shares > 0 {
                buffer_client.unlock_shares(&plan.user, &plan.protected_shares);
                log!(&env, "Liberados {} shares restantes", plan.protected_shares);
                plan.protected_shares = 0;
            }
        }
        
        // ===== GUARDAR PLAN ACTUALIZADO =====
        
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
    
    /// Obtener la próxima cuota vencida de un plan
    /// 
    /// Busca la primera cuota que esté pendiente y ya haya vencido.
    /// Útil para workers automáticos que procesan cobros.
    pub fn get_next_due(env: Env, plan_id: String) -> Result<Option<Installment>, ContractError> {
        let plan: BridgePlan = env.storage()
            .persistent()
            .get(&DataKey::Plan(plan_id))
            .ok_or(ContractError::PlanNotFound)?;
        
        let current_time = env.ledger().timestamp();
        
        // Buscar primera cuota pendiente y vencida
        for i in 0..plan.installments.len() {
            let installment = plan.installments.get(i).unwrap();
            if installment.status == InstallmentStatus::Pending 
                && installment.due_date <= current_time {
                return Ok(Some(installment));
            }
        }
        
        // No hay cuotas vencidas
        Ok(None)
    }
    
    /// Obtener resumen completo del plan con valores actualizados del Buffer
    /// 
    /// Retorna el plan junto con los valores actuales en tokens del Buffer
    /// del usuario (disponible y protegido). Útil para mostrar en UI.
    pub fn get_plan_summary(
        env: Env, 
        plan_id: String, 
        buffer_contract: Address
    ) -> Result<(BridgePlan, i128, i128), ContractError> {
        let plan = Self::get_plan(env.clone(), plan_id)?;
        
        let buffer_client = BufferContractClient::new(&env, &buffer_contract);
        let (available_value, protected_value, _total_value) = buffer_client.get_values(&plan.user);
        
        // Retorna: (plan, valor_disponible, valor_protegido)
        Ok((plan, available_value, protected_value))
    }

    }

// ============ TESTS CON MOCK BUFFER ============


#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, testutils::Ledger, Env, Vec as SorobanVec};
    
    // Mock SIMPLE sin tipos complejos
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
}