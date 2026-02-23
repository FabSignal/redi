import { rpc } from "@stellar/stellar-sdk";
import { SupabaseService } from "../supabase/supabase.service.js";
import { CrossmintService } from "../crossmint/crossmint.service.js";
import { DeFindexService } from "../defindex/defindex.service.js";

export interface OnboardingResult {
  userId: string;
  stellarAddress: string | null;
  vaultAddress: string | null;
  status: string;
}

export interface PrepareVaultResult {
  txId: string;
  transactionXDR: string;
  walletAddress: string;
  predictedVaultAddress: string | null;
}

export interface SubmitVaultResult {
  txId: string;
  transactionHash: string;
  vaultAddress: string;
  status: "READY";
}

export class OnboardingService {
  private readonly sorobanRpc: rpc.Server;

  constructor(
    private readonly supabase: SupabaseService,
    private readonly crossmint: CrossmintService,
    private readonly defindex: DeFindexService,
  ) {
    const network = process.env.STELLAR_NETWORK ?? "testnet";
    const rpcUrl =
      process.env.STELLAR_SOROBAN_RPC_URL ??
      (network === "mainnet"
        ? "https://mainnet.stellar.validationcloud.io/v1/XCeZqFTKymREBkxOH5ISRGEwFr5sXQ9Ye9sJU2FZ8q4="
        : "https://soroban-testnet.stellar.org");
    this.sorobanRpc = new rpc.Server(rpcUrl);
  }

  async onboardUser(userId: string, email: string): Promise<OnboardingResult> {
    console.info(`[OnboardingService] Starting onboarding for user ${userId}`);

    try {
      const user = await this.supabase.upsertUser(userId, email);

      if (user.buffer_onboarding_status === "READY") {
        console.info(`[OnboardingService] User ${userId} already onboarded`);
        return {
          userId,
          stellarAddress: (user.stellar_address as string | null) ?? null,
          vaultAddress: (user.defindex_vault_address as string | null) ?? null,
          status: "READY",
        };
      }

      if (!user.stellar_address) {
        await this.createWallet(userId, email);
      }

      const userWithWallet = await this.supabase.getUser(userId);
      const hasVault =
        typeof userWithWallet.defindex_vault_address === "string" &&
        userWithWallet.defindex_vault_address.length > 0;

      if (!hasVault) {
        const currentStatus =
          typeof userWithWallet.buffer_onboarding_status === "string" &&
          userWithWallet.buffer_onboarding_status.length > 0
            ? userWithWallet.buffer_onboarding_status
            : "WALLET_CREATED";
        if (currentStatus === "NOT_STARTED" || currentStatus === "PENDING") {
          await this.supabase.updateUserOnboardingStatus(userId, "WALLET_CREATED");
        }
      }

      const finalUser = await this.supabase.getUser(userId);

      return {
        userId,
        stellarAddress: (finalUser.stellar_address as string | null) ?? null,
        vaultAddress: (finalUser.defindex_vault_address as string | null) ?? null,
        status:
          typeof finalUser.buffer_onboarding_status === "string" &&
          finalUser.buffer_onboarding_status.length > 0
            ? finalUser.buffer_onboarding_status
            : "WALLET_CREATED",
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`[OnboardingService] Onboarding failed for user ${userId}: ${message}`);
      try {
        await this.supabase.updateUserOnboardingStatus(userId, "FAILED");
      } catch {}
      throw error;
    }
  }

  async prepareVaultCreation(userId: string): Promise<PrepareVaultResult> {
    const user = await this.supabase.getUser(userId);
    const stellarAddress =
      typeof user.stellar_address === "string" && user.stellar_address.length > 0
        ? user.stellar_address
        : null;

    if (!stellarAddress) {
      throw new Error("[OnboardingService] User has no wallet address. Complete wallet provisioning first.");
    }

    if (
      typeof user.defindex_vault_address === "string" &&
      user.defindex_vault_address.length > 0 &&
      user.buffer_onboarding_status === "READY"
    ) {
      throw new Error("[OnboardingService] User already has an active vault.");
    }

    await this.supabase.updateUserOnboardingStatus(userId, "VAULT_PREPARING");

    const vaultResponse = await this.defindex.createVaultForUser({
      userAddress: stellarAddress,
      assetAddress: process.env.XLM_CONTRACT_ADDRESS,
      strategyAddress: process.env.XLM_BLEND_STRATEGY,
    });

    const txId = await this.supabase.createBufferTransaction({
      userId,
      transactionType: "LOCK",
      status: "PENDING",
      metadata: {
        operation: "VAULT_CREATE",
        predictedVaultAddress: vaultResponse.predictedVaultAddress ?? null,
      },
    });

    await this.supabase.updateUserOnboardingStatus(userId, "VAULT_PENDING_SIGNATURE");

    return {
      txId,
      transactionXDR: vaultResponse.transactionXDR,
      walletAddress: stellarAddress,
      predictedVaultAddress: vaultResponse.predictedVaultAddress ?? null,
    };
  }

  async submitVaultCreation(
    userId: string,
    txId: string,
    transactionHash: string,
  ): Promise<SubmitVaultResult> {
    await this.supabase.confirmBufferTransactionForUser(userId, txId, transactionHash);
    const record = await this.supabase.getBufferTransactionForUser(userId, txId);

    const predictedVaultAddress =
      record.metadata && typeof record.metadata.predictedVaultAddress === "string"
        ? record.metadata.predictedVaultAddress
        : null;

    if (!predictedVaultAddress) {
      throw new Error("[OnboardingService] Missing predicted vault address for submitted vault transaction.");
    }

    let rpcResult = await this.sorobanRpc.getTransaction(transactionHash);
    for (
      let i = 0;
      i < 10 && rpcResult.status === rpc.Api.GetTransactionStatus.NOT_FOUND;
      i++
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
      rpcResult = await this.sorobanRpc.getTransaction(transactionHash);
    }

    if (rpcResult.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new Error(`[OnboardingService] Vault submit RPC status: ${rpcResult.status}`);
    }

    const confirmed = await this.defindex.waitForVaultConfirmation(predictedVaultAddress);
    if (!confirmed) {
      throw new Error(
        `[OnboardingService] Vault ${predictedVaultAddress} not confirmed by DeFindex API after polling`,
      );
    }

    await this.supabase.updateUserOnboardingStatus(userId, "READY", {
      defindex_vault_address: predictedVaultAddress,
    });

    return {
      txId,
      transactionHash,
      vaultAddress: predictedVaultAddress,
      status: "READY",
    };
  }

  private async createWallet(userId: string, email: string): Promise<void> {
    console.info(`[OnboardingService] [1/2] Creating Crossmint wallet for user ${userId}`);

    const wallet = await this.crossmint.createWalletForUser(email);

    await this.supabase.updateUserOnboardingStatus(userId, "WALLET_CREATED", {
      stellar_address: wallet.address,
      crossmint_wallet_id: wallet.walletId,
    });

    console.info(`[OnboardingService] Wallet created: ${wallet.address}`);
  }
}
