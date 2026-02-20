import { createClient, SupabaseClient } from "@supabase/supabase-js";

export interface BufferOnboardingData {
  stellar_address?: string;
  crossmint_wallet_id?: string;
  defindex_vault_address?: string;
}

export interface BufferTransactionInput {
  userId: string;
  transactionType: string;
  amountStroops?: number;
  sharesDelta?: number;
  status?: string;
}

export interface BufferTransactionUpdate {
  stellarTxHash?: string;
  status?: string;
  confirmedAt?: Date;
  errorMessage?: string;
}

export interface UserBalanceData {
  availableShares: string;
  protectedShares: string;
  totalDeposited: string;
}

export class SupabaseService {
  private readonly client: SupabaseClient;

  constructor() {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      throw new Error(
        "[SupabaseService] Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY",
      );
    }

    this.client = createClient(supabaseUrl, supabaseKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }

  getClient(): SupabaseClient {
    return this.client;
  }

  async updateUserOnboardingStatus(
    userId: string,
    status: string,
    data?: Partial<BufferOnboardingData>,
  ): Promise<void> {
    const updateData = {
      buffer_onboarding_status: status,
      ...data,
      updated_at: new Date().toISOString(),
    };

    const { error } = await this.client.from("profiles").update(updateData).eq("id", userId);

    if (error) {
      throw new Error(`[SupabaseService] updateUserOnboardingStatus failed: ${error.message}`);
    }
  }

  async getUser(userId: string): Promise<Record<string, unknown>> {
    const { data, error } = await this.client
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .single();

    if (error) {
      throw new Error(`[SupabaseService] getUser failed for ${userId}: ${error.message}`);
    }

    return data as Record<string, unknown>;
  }

  async createBufferTransaction(transaction: BufferTransactionInput): Promise<string> {
    const { data, error } = await this.client
      .from("buffer_transactions")
      .insert({
        user_id: transaction.userId,
        transaction_type: transaction.transactionType,
        amount_stroops: transaction.amountStroops ?? null,
        shares_delta: transaction.sharesDelta ?? null,
        status: transaction.status ?? "PENDING",
      })
      .select("id")
      .single();

    if (error) {
      throw new Error(`[SupabaseService] createBufferTransaction failed: ${error.message}`);
    }

    return (data as { id: string }).id;
  }

  async updateBufferTransaction(
    transactionId: string,
    updates: BufferTransactionUpdate,
  ): Promise<void> {
    const { error } = await this.client
      .from("buffer_transactions")
      .update({
        stellar_tx_hash: updates.stellarTxHash ?? null,
        status: updates.status ?? null,
        confirmed_at: updates.confirmedAt?.toISOString() ?? null,
        error_message: updates.errorMessage ?? null,
      })
      .eq("id", transactionId);

    if (error) {
      throw new Error(`[SupabaseService] updateBufferTransaction failed: ${error.message}`);
    }
  }

  async syncUserBalance(userId: string, balanceData: UserBalanceData): Promise<void> {
    const { error } = await this.client
      .from("profiles")
      .update({
        buffer_available_shares: balanceData.availableShares,
        buffer_protected_shares: balanceData.protectedShares,
        buffer_total_deposited: balanceData.totalDeposited,
        buffer_last_synced_at: new Date().toISOString(),
      })
      .eq("id", userId);

    if (error) {
      throw new Error(`[SupabaseService] syncUserBalance failed for ${userId}: ${error.message}`);
    }
  }
}
