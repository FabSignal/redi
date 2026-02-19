// v3
#![no_std]
#![allow(unused_variables)] 

use soroban_sdk::{
    contract, contractimpl, contracttype, Address, Env, Symbol, Vec, vec
};

mod vault_import {
    soroban_sdk::contractimport!(file = "defindex_vault.wasm");
}
use vault_import::Client as DeFindexVaultClient;

const MIN_AMOUNT: i128 = 1;
const DEFAULT_SLIPPAGE_BPS: i128 = 50;
const DEFAULT_MIN_INTERVAL_SECS: u64 = 2;
const BPS_DIVISOR: i128 = 10000;

#[contracttype]
#[derive(Clone)]
pub struct BufferBalance {
    pub available_shares: i128,
    pub protected_shares: i128,
    pub total_deposited: i128,
    pub last_deposit_ts: u64,
    pub version: u64,
}

#[contracttype]
#[derive(Clone)]
pub struct DepositResult {
    pub shares_minted: i128,
    pub amount_deposited: i128,
    pub new_available_balance: i128,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone)]
pub struct WithdrawResult {
    pub shares_burned: i128,
    pub amounts_received: Vec<i128>,
    pub new_available_balance: i128,
    pub from_protected: bool,
}

#[contracttype]
#[derive(Clone)]
pub struct LockResult {
    pub shares_locked: i128,
    pub new_available: i128,
    pub new_protected: i128,
}

#[contracttype]
#[derive(Clone)]
pub struct ContractConfig {
    pub min_deposit_interval: u64,
    pub slippage_tolerance_bps: i128,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Vault,
    Asset,
    Bridge,
    Paused,
    Config,
    Balance(Address),
    TotalStats,
    BlendStrategy,
}

#[contracttype]
#[derive(Clone)]
pub struct TotalStats {
    pub total_available: i128,
    pub total_protected: i128,
    pub total_deposited: i128,
    pub unique_users: u32,
}

#[contract]
pub struct BufferContract;

#[contractimpl]
impl BufferContract {
    pub fn __constructor(env: Env, admin: Address, vault: Address, asset: Address, blend_strategy: Address) {
        admin.require_auth();
        
        Self::validate_non_zero_address(&env, &admin);
        Self::validate_non_zero_address(&env, &vault);
        Self::validate_non_zero_address(&env, &asset);
        Self::validate_non_zero_address(&env, &blend_strategy);
        
        let storage = env.storage().instance();
        storage.set(&DataKey::Admin, &admin);
        storage.set(&DataKey::Vault, &vault);
        storage.set(&DataKey::Asset, &asset);
        storage.set(&DataKey::BlendStrategy, &blend_strategy);
        storage.set(&DataKey::Paused, &false);
        storage.set(&DataKey::Config, &ContractConfig {
            min_deposit_interval: DEFAULT_MIN_INTERVAL_SECS,
            slippage_tolerance_bps: DEFAULT_SLIPPAGE_BPS,
        });
        
        env.storage().persistent().set(&DataKey::TotalStats, &TotalStats {
            total_available: 0,
            total_protected: 0,
            total_deposited: 0,
            unique_users: 0,
        });
        
        env.events().publish(
            (Symbol::new(&env, "initialized"),),
            (admin.clone(), vault, asset, blend_strategy)
        );
    }

    pub fn set_bridge(env: Env, bridge: Address) {
        let admin: Address = env.storage().instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic!("Admin not set"));
        admin.require_auth();
        
        Self::validate_non_zero_address(&env, &bridge);
        env.storage().instance().set(&DataKey::Bridge, &bridge);
        
        env.events().publish((Symbol::new(&env, "bridge_set"),), bridge);
    }

    pub fn update_config(env: Env, min_deposit_interval: u64, slippage_tolerance_bps: i128) {
        let admin: Address = env.storage().instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic!("Admin not set"));
        admin.require_auth();
        
        env.storage().instance().set(&DataKey::Config, &ContractConfig {
            min_deposit_interval,
            slippage_tolerance_bps,
        });
        
        env.events().publish(
            (Symbol::new(&env, "config_updated"),),
            (min_deposit_interval, slippage_tolerance_bps)
        );
    }

    pub fn emergency_pause(env: Env) {
        let admin: Address = env.storage().instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic!("Admin not set"));
        admin.require_auth();
        
        env.storage().instance().set(&DataKey::Paused, &true);
        env.events().publish((Symbol::new(&env, "paused"),), admin);
    }

    pub fn emergency_unpause(env: Env) {
        let admin: Address = env.storage().instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic!("Admin not set"));
        admin.require_auth();
        
        env.storage().instance().set(&DataKey::Paused, &false);
        env.events().publish((Symbol::new(&env, "unpaused"),), admin);
    }

    pub fn deposit(env: Env, user: Address, amount: i128) -> DepositResult {
        user.require_auth();
        Self::require_not_paused(&env);
        
        if amount < MIN_AMOUNT {
            panic!("Invalid amount");
        }

        let vault: Address = env.storage().instance()
            .get(&DataKey::Vault)
            .unwrap_or_else(|| panic!("Vault not configured"));

        let config: ContractConfig = env.storage().instance()
            .get(&DataKey::Config)
            .unwrap_or(ContractConfig {
                min_deposit_interval: DEFAULT_MIN_INTERVAL_SECS,
                slippage_tolerance_bps: DEFAULT_SLIPPAGE_BPS,
            });

        let bal = Self::get_balance_or_default(env.clone(), user.clone());
        let is_new_user = bal.version == 0;
        let original_version = bal.version;
        
        let current_ts = env.ledger().timestamp();
        
        if bal.last_deposit_ts > 0 {
            if current_ts < bal.last_deposit_ts {
                panic!("Invalid timestamp");
            }
            if current_ts - bal.last_deposit_ts < config.min_deposit_interval {
                panic!("Deposit too frequent");
            }
        }
        
        let (total_managed_before, total_shares) = Self::vault_totals(env.clone());
        
        let expected_shares = if total_shares == 0 || total_managed_before == 0 {
            amount
        } else {
            mul_div_ceil(&env, amount, total_shares, total_managed_before)
        };
        
        let slippage_amount = mul_div(&env, expected_shares, config.slippage_tolerance_bps, BPS_DIVISOR);
        let min_shares_out = checked_sub(&env, expected_shares, slippage_amount);

        let vault_client = DeFindexVaultClient::new(&env, &vault);

        let result = vault_client.deposit(
            &vec![&env, amount],
            &vec![&env, min_shares_out],
            &user,
            &true
        );

        let actual_shares: i128 = result.1;

        let funds_after_deposit = vault_client.fetch_total_managed_funds();
        let asset_allocation = funds_after_deposit.get(0).unwrap();
        
        if asset_allocation.invested_amount == 0 && asset_allocation.idle_amount > 0 {
            let blend_strategy: Address = env.storage().instance()
                .get(&DataKey::BlendStrategy)
                .unwrap_or_else(|| panic!("Blend strategy not configured"));
            
            let total_idle = asset_allocation.idle_amount;
            
            vault_client.rebalance(
                &user,
                &vec![&env, vault_import::Instruction::Invest(blend_strategy, total_idle)]
            );
        }

        if actual_shares <= 0 {
            panic!("Invalid vault response");
        }
        
        if actual_shares < min_shares_out {
            panic!("Slippage exceeded");
        }
        
        let mut current_bal: BufferBalance = env.storage().persistent()
            .get(&DataKey::Balance(user.clone()))
            .unwrap_or_else(|| BufferBalance {
                available_shares: 0,
                protected_shares: 0,
                total_deposited: 0,
                last_deposit_ts: 0,
                version: 0,
            });
        
        if current_bal.version != original_version {
            panic!("Concurrent modification");
        }
        
        current_bal.available_shares = checked_add(&env, current_bal.available_shares, actual_shares);
        current_bal.total_deposited = checked_add(&env, current_bal.total_deposited, amount);
        current_bal.last_deposit_ts = current_ts;
        current_bal.version = checked_add_u64(&env, current_bal.version, 1);
        
        env.storage().persistent().set(&DataKey::Balance(user.clone()), &current_bal);
        
        Self::update_total_stats(&env, actual_shares, 0, amount, is_new_user);
        
        env.events().publish(
            (Symbol::new(&env, "deposit"), user),
            (amount, actual_shares, current_ts)
        );
        
        DepositResult {
            shares_minted: actual_shares,
            amount_deposited: amount,
            new_available_balance: current_bal.available_shares,
            timestamp: current_ts,
        }
    }

    pub fn withdraw_available(
        env: Env,
        user: Address,
        shares: i128,
        to: Address
    ) -> WithdrawResult {
        user.require_auth();
        Self::require_not_paused(&env);
        Self::withdraw_internal(env, user, shares, to, false)
    }

    pub fn lock_shares(env: Env, user: Address, shares: i128) -> LockResult {
        Self::require_bridge(env.clone());
        Self::require_not_paused(&env);
        
        if shares < MIN_AMOUNT {
            panic!("Invalid amount");
        }

        let mut bal = Self::get_balance_or_default(env.clone(), user.clone());
        
        if bal.available_shares < shares {
            panic!("Insufficient available");
        }

        bal.available_shares = checked_sub(&env, bal.available_shares, shares);
        bal.protected_shares = checked_add(&env, bal.protected_shares, shares);
        bal.version = checked_add_u64(&env, bal.version, 1);

        env.storage().persistent().set(&DataKey::Balance(user.clone()), &bal);
        
        Self::update_total_stats(&env, -shares, shares, 0, false);

        env.events().publish((Symbol::new(&env, "lock"), user.clone()), shares);
        
        LockResult {
            shares_locked: shares,
            new_available: bal.available_shares,
            new_protected: bal.protected_shares,
        }
    }

    pub fn unlock_shares(env: Env, user: Address, shares: i128) -> LockResult {
        Self::require_bridge(env.clone());
        
        if shares < MIN_AMOUNT {
            panic!("Invalid amount");
        }

        let mut bal = Self::get_balance_or_default(env.clone(), user.clone());
        
        if bal.protected_shares < shares {
            panic!("Insufficient protected");
        }

        bal.protected_shares = checked_sub(&env, bal.protected_shares, shares);
        bal.available_shares = checked_add(&env, bal.available_shares, shares);
        bal.version = checked_add_u64(&env, bal.version, 1);

        env.storage().persistent().set(&DataKey::Balance(user.clone()), &bal);
        
        Self::update_total_stats(&env, shares, -shares, 0, false);

        env.events().publish((Symbol::new(&env, "unlock"), user.clone()), shares);
        
        LockResult {
            shares_locked: shares,
            new_available: bal.available_shares,
            new_protected: bal.protected_shares,
        }
    }

    pub fn debit_available(
        env: Env,
        user: Address,
        shares: i128,
        to: Address
    ) -> WithdrawResult {
        Self::require_bridge(env.clone());
        Self::withdraw_internal(env, user, shares, to, false)
    }

    pub fn debit_protected(
        env: Env,
        user: Address,
        shares: i128,
        to: Address
    ) -> WithdrawResult {
        Self::require_bridge(env.clone());
        Self::withdraw_internal(env, user, shares, to, true)
    }

    pub fn get_balance(env: Env, user: Address) -> BufferBalance {
        Self::get_balance_or_default(env, user)
    }

    pub fn get_shares(env: Env, user: Address) -> (i128, i128, i128) {
        let bal = Self::get_balance_or_default(env.clone(), user);
        let total = checked_add(&env, bal.available_shares, bal.protected_shares);
        (bal.available_shares, bal.protected_shares, total)
    }

    pub fn get_values(env: Env, user: Address) -> (i128, i128, i128) {
        let bal = Self::get_balance_or_default(env.clone(), user);
        let total_shares = checked_add(&env, bal.available_shares, bal.protected_shares);
        
        let (total_managed, vault_total_shares) = Self::vault_totals(env.clone());
        
        let total_value = if total_shares == 0 || vault_total_shares == 0 {
            0
        } else {
            mul_div(&env, total_shares, total_managed, vault_total_shares)
        };
        
        let available_value = if bal.available_shares == 0 || vault_total_shares == 0 {
            0
        } else {
            mul_div(&env, bal.available_shares, total_managed, vault_total_shares)
        };
        
        let protected_value = checked_sub(&env, total_value, available_value);
        
        (available_value, protected_value, total_value)
    }

    pub fn shares_for_amount(env: Env, amount: i128) -> i128 {
        if amount < MIN_AMOUNT {
            panic!("Invalid amount");
        }
        
        let (total_managed, total_shares) = Self::vault_totals(env.clone());
        
        if total_shares == 0 || total_managed == 0 {
            amount
        } else {
            mul_div_ceil(&env, amount, total_shares, total_managed)
        }
    }

    pub fn get_total_stats(env: Env) -> TotalStats {
        env.storage().persistent().get(&DataKey::TotalStats)
            .unwrap_or(TotalStats {
                total_available: 0,
                total_protected: 0,
                total_deposited: 0,
                unique_users: 0,
            })
    }

    pub fn get_config(env: Env) -> ContractConfig {
        env.storage().instance().get(&DataKey::Config)
            .unwrap_or(ContractConfig {
                min_deposit_interval: DEFAULT_MIN_INTERVAL_SECS,
                slippage_tolerance_bps: DEFAULT_SLIPPAGE_BPS,
            })
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage().instance().get(&DataKey::Paused).unwrap_or(false)
    }

    fn withdraw_internal(
        env: Env,
        user: Address,
        shares: i128,
        to: Address,
        from_protected: bool
    ) -> WithdrawResult {
        if shares < MIN_AMOUNT {
            panic!("Invalid amount");
        }

        let vault: Address = env.storage().instance()
            .get(&DataKey::Vault)
            .unwrap_or_else(|| panic!("Vault not configured"));

        let mut bal = Self::get_balance_or_default(env.clone(), user.clone());

        if from_protected {
            if bal.protected_shares < shares {
                panic!("Insufficient protected");
            }
            bal.protected_shares = checked_sub(&env, bal.protected_shares, shares);
        } else {
            if bal.available_shares < shares {
                panic!("Insufficient available");
            }
            bal.available_shares = checked_sub(&env, bal.available_shares, shares);
        }
        
        bal.version = checked_add_u64(&env, bal.version, 1);

        env.storage().persistent().set(&DataKey::Balance(user.clone()), &bal);

        let vault_client = DeFindexVaultClient::new(&env, &vault);
        let amounts = vault_client.withdraw(&shares, &vec![&env, 0], &to);
        
        if from_protected {
            Self::update_total_stats(&env, 0, -shares, 0, false);
        } else {
            Self::update_total_stats(&env, -shares, 0, 0, false);
        }

        env.events().publish(
            (Symbol::new(&env, "withdraw"), user.clone()),
            (to, shares, amounts.clone(), from_protected)
        );
        
        WithdrawResult {
            shares_burned: shares,
            amounts_received: amounts,
            new_available_balance: bal.available_shares,
            from_protected,
        }
    }

    fn get_balance_or_default(env: Env, user: Address) -> BufferBalance {
        env.storage().persistent().get(&DataKey::Balance(user))
            .unwrap_or(BufferBalance {
                available_shares: 0,
                protected_shares: 0,
                total_deposited: 0,
                last_deposit_ts: 0,
                version: 0,
            })
    }

    fn validate_non_zero_address(env: &Env, address: &Address) {
        let addr_str = address.to_string();
        if addr_str.len() == 0 {
            panic!("Zero address");
        }
    }

    fn require_bridge(env: Env) {
        let bridge: Address = env.storage().instance()
            .get(&DataKey::Bridge)
            .unwrap_or_else(|| panic!("Bridge not set"));
        bridge.require_auth();
    }

    fn require_not_paused(env: &Env) {
        let paused: bool = env.storage().instance().get(&DataKey::Paused).unwrap_or(false);
        if paused {
            panic!("Contract paused");
        }
    }

    fn vault_totals(env: Env) -> (i128, i128) {
        let vault: Address = env.storage().instance()
            .get(&DataKey::Vault)
            .unwrap_or_else(|| panic!("Vault not configured"));
        
        let vault_client = DeFindexVaultClient::new(&env, &vault);
        let total_shares = vault_client.total_supply();
        let funds = vault_client.fetch_total_managed_funds();
        
        let mut total_managed = 0i128;
        for f in funds.iter() {
            total_managed = checked_add(&env, total_managed, f.total_amount);
        }
        
        (total_managed, total_shares)
    }

    fn update_total_stats(
        env: &Env,
        available_delta: i128,
        protected_delta: i128,
        deposited_delta: i128,
        is_new_user: bool,
    ) {
        let mut stats: TotalStats = env.storage().persistent()
            .get(&DataKey::TotalStats)
            .unwrap_or(TotalStats {
                total_available: 0,
                total_protected: 0,
                total_deposited: 0,
                unique_users: 0,
            });
        
        stats.total_available = checked_add(env, stats.total_available, available_delta);
        stats.total_protected = checked_add(env, stats.total_protected, protected_delta);
        stats.total_deposited = checked_add(env, stats.total_deposited, deposited_delta);
        
        if is_new_user {
            stats.unique_users = stats.unique_users.checked_add(1)
                .unwrap_or_else(|| panic!("Math overflow"));
        }
        
        env.storage().persistent().set(&DataKey::TotalStats, &stats);
    }
}

#[inline(always)]
fn checked_add(env: &Env, a: i128, b: i128) -> i128 {
    a.checked_add(b).unwrap_or_else(|| panic!("Math overflow"))
}

#[inline(always)]
fn checked_sub(env: &Env, a: i128, b: i128) -> i128 {
    a.checked_sub(b).unwrap_or_else(|| panic!("Math overflow"))
}

#[inline(always)]
fn checked_add_u64(env: &Env, a: u64, b: u64) -> u64 {
    a.checked_add(b).unwrap_or_else(|| panic!("Math overflow"))
}

#[inline(always)]
fn mul_div(env: &Env, a: i128, b: i128, c: i128) -> i128 {
    if c == 0 {
        panic!("Division by zero");
    }
    let numerator = a.checked_mul(b)
        .unwrap_or_else(|| panic!("Math overflow"));
    numerator / c
}

#[inline(always)]
fn mul_div_ceil(env: &Env, a: i128, b: i128, c: i128) -> i128 {
    if c == 0 {
        panic!("Division by zero");
    }
    let prod = a.checked_mul(b)
        .unwrap_or_else(|| panic!("Math overflow"));
    let div = prod / c;
    let remainder = prod % c;
    if remainder == 0 {
        div
    } else {
        div.checked_add(1)
            .unwrap_or_else(|| panic!("Math overflow"))
    }
}