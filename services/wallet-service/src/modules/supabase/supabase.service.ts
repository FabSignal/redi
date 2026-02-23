import { createClient, SupabaseClient } from "@supabase/supabase-js";

export interface BufferOnboardingData {
  stellar_address?: string;
  crossmint_wallet_id?: string;
  defindex_vault_address?: string;
  buffer_contract_address?: string;
}

export interface BufferTransactionInput {
  userId: string;
  transactionType: "DEPOSIT" | "WITHDRAW" | "LOCK" | "UNLOCK";
  amountStroops?: string | number | bigint;
  sharesDelta?: string | number | bigint;
  status?: "PENDING" | "CONFIRMED" | "FAILED";
  metadata?: Record<string, unknown> | null;
}

export interface BufferTransactionUpdate {
  stellarTxHash?: string;
  status?: string;
  confirmedAt?: Date;
  errorMessage?: string;
}

export interface BufferTransactionRecord {
  id: string;
  profileId: string;
  transactionType: string;
  status: string | null;
  stellarTxHash: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string | null;
  confirmedAt: string | null;
}

export interface UserBalanceData {
  availableShares: string;
  protectedShares: string;
  totalDeposited: string;
}

export interface UserBufferConfig {
  stellarAddress: string | null;
  bufferContractAddress: string | null;
  onboardingStatus: string | null;
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

  async upsertUser(userId: string, email: string): Promise<Record<string, unknown>> {
    const { error } = await this.client
      .from("profiles")
      .upsert(
        { id: userId, email, buffer_onboarding_status: "PENDING" },
        { onConflict: "id", ignoreDuplicates: true },
      );

    if (error) {
      throw new Error(`[SupabaseService] upsertUser failed for ${userId}: ${error.message}`);
    }

    return this.getUser(userId);
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

  async getUserBufferConfig(userId: string): Promise<UserBufferConfig> {
    const { data, error } = await this.client
      .from("profiles")
      .select("stellar_address, buffer_contract_address, buffer_onboarding_status")
      .eq("id", userId)
      .single();

    if (error) {
      throw new Error(`[SupabaseService] getUserBufferConfig failed for ${userId}: ${error.message}`);
    }

    return {
      stellarAddress:
        typeof data.stellar_address === "string" && data.stellar_address.length > 0
          ? data.stellar_address
          : null,
      bufferContractAddress:
        typeof data.buffer_contract_address === "string" && data.buffer_contract_address.length > 0
          ? data.buffer_contract_address
          : null,
      onboardingStatus:
        typeof data.buffer_onboarding_status === "string" && data.buffer_onboarding_status.length > 0
          ? data.buffer_onboarding_status
          : null,
    };
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

  async createBufferTransaction(transaction: BufferTransactionInput): Promise<string> {
    const payload: Record<string, unknown> = {
      profile_id: transaction.userId,
      transaction_type: transaction.transactionType,
      amount_stroops:
        transaction.amountStroops === undefined || transaction.amountStroops === null
          ? null
          : transaction.amountStroops.toString(),
      shares_delta:
        transaction.sharesDelta === undefined || transaction.sharesDelta === null
          ? null
          : transaction.sharesDelta.toString(),
      status: transaction.status ?? "PENDING",
      metadata: transaction.metadata ?? null,
    };

    const result = await this.client.from("buffer_transactions").insert(payload).select("id").single();
    if (result.error) {
      throw new Error(
        `[SupabaseService] createBufferTransaction failed for ${transaction.userId}: ${result.error.message}`,
      );
    }

    const txId = result.data?.id;
    if (typeof txId !== "string" || txId.length === 0) {
      throw new Error(
        `[SupabaseService] createBufferTransaction failed for ${transaction.userId}: missing id in insert response`,
      );
    }

    return txId;
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

  async confirmBufferTransactionForUser(
    userId: string,
    transactionId: string,
    transactionHash: string,
  ): Promise<void> {
    const result = await this.client
      .from("buffer_transactions")
      .update({
        stellar_tx_hash: transactionHash,
        status: "CONFIRMED",
        confirmed_at: new Date().toISOString(),
        error_message: null,
      })
      .eq("id", transactionId)
      .eq("profile_id", userId)
      .select("id")
      .single();

    if (result.error) {
      throw new Error(
        `[SupabaseService] confirmBufferTransactionForUser failed for tx ${transactionId}: ${result.error.message}`,
      );
    }

    if (!result.data?.id) {
      throw new Error(
        `[SupabaseService] confirmBufferTransactionForUser failed for tx ${transactionId}: transaction not found`,
      );
    }
  }

  async getBufferTransactionForUser(
    userId: string,
    transactionId: string,
  ): Promise<BufferTransactionRecord> {
    const result = await this.client
      .from("buffer_transactions")
      .select(
        "id, profile_id, transaction_type, status, stellar_tx_hash, metadata, created_at, confirmed_at",
      )
      .eq("id", transactionId)
      .eq("profile_id", userId)
      .single();

    if (result.error || !result.data) {
      throw new Error(
        `[SupabaseService] getBufferTransactionForUser failed for tx ${transactionId}: ${
          result.error?.message ?? "transaction not found"
        }`,
      );
    }

    return {
      id: String(result.data.id),
      profileId: String(result.data.profile_id),
      transactionType: String(result.data.transaction_type),
      status:
        typeof result.data.status === "string" && result.data.status.length > 0
          ? result.data.status
          : null,
      stellarTxHash:
        typeof result.data.stellar_tx_hash === "string" && result.data.stellar_tx_hash.length > 0
          ? result.data.stellar_tx_hash
          : null,
      metadata:
        result.data.metadata && typeof result.data.metadata === "object"
          ? (result.data.metadata as Record<string, unknown>)
          : null,
      createdAt:
        typeof result.data.created_at === "string" && result.data.created_at.length > 0
          ? result.data.created_at
          : null,
      confirmedAt:
        typeof result.data.confirmed_at === "string" && result.data.confirmed_at.length > 0
          ? result.data.confirmed_at
          : null,
    };
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
