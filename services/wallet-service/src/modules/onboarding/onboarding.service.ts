import { Injectable } from "@nestjs/common";
import { RuntimeConfigService } from "../../common/config/runtime-config.service.js";
import { AppError } from "../../common/errors/app-error.js";
import { SupabaseService } from "../supabase/supabase.service.js";
import { CrossmintService } from "../crossmint/crossmint.service.js";
import { DeFindexService } from "../defindex/defindex.service.js";
import { BufferService } from "../buffer/buffer.service.js";
import { structuredLog } from "../../utils/structured-log.js";

export interface OnboardingResult {
  userId: string;
  stellarAddress: string | null;
  vaultAddress: string | null;
  status: string;
}

export interface CreateVaultResult {
  txId: string;
  status: "PROCESSING";
}

@Injectable()
export class OnboardingService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly crossmint: CrossmintService,
    private readonly defindex: DeFindexService,
    private readonly bufferService: BufferService,
    private readonly runtimeConfig: RuntimeConfigService,
  ) {}

  async onboardUser(userId: string, email: string): Promise<OnboardingResult> {
    console.info(`[OnboardingService] Starting onboarding for user ${userId}`);

    try {
      const user = await this.supabase.upsertUser(userId, email);

      if (user.buffer_onboarding_status === "READY") {
        const result = {
          userId,
          stellarAddress: (user.stellar_address as string | null) ?? null,
          vaultAddress: (user.defindex_vault_address as string | null) ?? null,
          status: "READY",
        };
        structuredLog.info("OnboardingService", "onboarding.already_ready", result);
        if (result.vaultAddress) {
          void this.defindex
            .logVaultInfo(result.vaultAddress, `onboardUser existing vault user=${userId}`)
            .catch((error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              console.warn(
                `[OnboardingService] Failed to log existing vault info for user=${userId} vault=${result.vaultAddress}: ${message}`,
              );
            });
        }
        return result;
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
      const result = {
        userId,
        stellarAddress: (finalUser.stellar_address as string | null) ?? null,
        vaultAddress: (finalUser.defindex_vault_address as string | null) ?? null,
        status:
          typeof finalUser.buffer_onboarding_status === "string" &&
          finalUser.buffer_onboarding_status.length > 0
            ? finalUser.buffer_onboarding_status
            : "WALLET_CREATED",
      };
      structuredLog.info("OnboardingService", "onboarding.state", result);
      return result;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`[OnboardingService] Onboarding failed for user ${userId}: ${message}`);
      try {
        await this.supabase.updateUserOnboardingStatus(userId, "FAILED");
      } catch {}
      throw error;
    }
  }

  async getStatus(userId: string) {
    try {
      const user = await this.supabase.getUser(userId);
      return {
        userId,
        status: user.buffer_onboarding_status ?? "PENDING",
        stellarAddress: user.stellar_address ?? null,
        vaultAddress: user.defindex_vault_address ?? null,
      };
    } catch {
      return { userId, status: "NOT_STARTED" };
    }
  }

  async queueVaultCreation(userId: string): Promise<CreateVaultResult> {
    const result = await this.startVaultCreation(userId);

    void this.runVaultCreationBackground(userId, result.txId).catch(async (err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(
        `[OnboardingService] runVaultCreationBackground uncaught error: user=${userId} txId=${result.txId} err=${error.message}`,
      );
      await this.supabase.updateUserOnboardingStatus(userId, "FAILED").catch(() => {});
      await this.supabase
        .updateBufferTransactionStatus(result.txId, "FAILED", { error: error.message })
        .catch(() => {});
    });

    return result;
  }

  /**
   * Synchronous part of vault creation: validates preconditions and creates the
   * buffer_transactions row. Returns immediately with a txId and PROCESSING status.
   * The caller must fire runVaultCreationBackground() after this returns.
   */
  async startVaultCreation(userId: string): Promise<CreateVaultResult> {
    const user = await this.supabase.getUser(userId);

    const stellarAddress =
      typeof user.stellar_address === "string" && user.stellar_address.length > 0
        ? user.stellar_address
        : null;

    if (!stellarAddress) {
      throw new AppError(
        "WALLET_NOT_READY",
        409,
        "User has no wallet address. Complete wallet provisioning first.",
      );
    }

    if (user.buffer_onboarding_status === "READY") {
      throw new AppError("ALREADY_READY", 409, "User already has an active vault.");
    }

    if (user.buffer_onboarding_status === "VAULT_CREATING") {
      throw new AppError("VAULT_IN_PROGRESS", 409, "Vault creation already in progress.");
    }

    await this.supabase.updateUserOnboardingStatus(userId, "VAULT_CREATING");

    const txId = await this.supabase.createBufferTransaction({
      userId,
      transactionType: "LOCK",
      status: "PENDING",
      metadata: { operation: "VAULT_CREATE" },
    });

    console.info(`[OnboardingService] Vault creation started for user=${userId} txId=${txId}`);

    return { txId, status: "PROCESSING" };
  }

  /**
   * Background part of vault creation. Signs and submits the DeFindex vault XDR
   * with the admin keypair, then binds the vault in the Buffer contract.
   *
   * Must be called fire-and-forget after startVaultCreation(). The controller
   * wraps this in a .catch() that sets FAILED in both tables if an uncaught
   * error escapes this method.
   *
   * Error handling: every failure sets onboarding status to FAILED and marks the
   * buffer_transactions row FAILED. Users can retry by calling /vault/create again.
   */
  async runVaultCreationBackground(userId: string, txId: string): Promise<void> {
    let predictedVaultAddress: string | null = null;

    try {
      const user = await this.supabase.getUser(userId);
      const stellarAddress =
        typeof user.stellar_address === "string" && user.stellar_address.length > 0
          ? user.stellar_address
          : null;

      if (!stellarAddress) {
        throw new Error("[OnboardingService] Missing stellar address in background job.");
      }

      const bufferContractId = this.runtimeConfig.bufferContractId;
      if (!bufferContractId) {
        throw new Error("[OnboardingService] Missing BUFFER_CONTRACT_ID.");
      }

      // Step 1: request DeFindex vault XDR
      console.info(`[OnboardingService] [bg] Requesting vault XDR for user=${userId}`);
      const vaultResponse = await this.defindex.createVaultForUser({
        userAddress: stellarAddress,
        assetAddress: this.runtimeConfig.xlmContractAddress,
        strategyAddress: this.runtimeConfig.xlmBlendStrategy,
      });

      if (!vaultResponse.transactionXDR || vaultResponse.transactionXDR.length === 0) {
        throw new Error("[OnboardingService] DeFindex returned empty transactionXDR.");
      }

      // predictedVaultAddress may be absent from the DeFindex response.
      // We proceed to submit regardless — the vault address will be resolved
      // from the Soroban transaction return value after on-chain confirmation.
      const predictedFromDefindex = vaultResponse.predictedVaultAddress ?? null;
      console.info(
        `[OnboardingService] [bg] Vault XDR received. predictedVaultAddress=${predictedFromDefindex ?? "(not in response — will resolve from tx)"}`,
      );

      // Step 2: admin signs and submits the vault XDR
      console.info(`[OnboardingService] [bg] Signing and submitting vault XDR`);
      const { hash: vaultTxHash, vaultAddress: vaultAddressFromTx } =
        await this.bufferService.createVaultFromXdr(vaultResponse.transactionXDR);
      console.info(`[OnboardingService] [bg] Vault XDR confirmed on-chain, hash=${vaultTxHash}`);

      // Step 3: record the confirmed on-chain transaction
      await this.supabase.confirmBufferTransactionForUser(userId, txId, vaultTxHash);

      // Step 4: resolve vault address — fallback chain
      // (a) From DeFindex response (most common)
      // (b) From Soroban tx return value (create_defindex_vault returns Address)
      console.info(`[OnboardingService] [bg] Resolving vault address...`);
      if (predictedFromDefindex) {
        predictedVaultAddress = predictedFromDefindex;
        console.info(
          `[OnboardingService] [bg] Vault address resolved from DeFindex response: ${predictedVaultAddress}`,
        );
      } else if (vaultAddressFromTx) {
        predictedVaultAddress = vaultAddressFromTx;
        console.info(
          `[OnboardingService] [bg] Vault address resolved from Soroban tx return value: ${predictedVaultAddress}`,
        );
      }

      if (!predictedVaultAddress) {
        throw new Error(
          `[OnboardingService] Could not resolve vault address after on-chain success. ` +
            `tx=${vaultTxHash}. DeFindex response had no predictedVaultAddress and tx return value was not parseable.`,
        );
      }

      // Step 5: wait for DeFindex to index the vault
      console.info(
        `[OnboardingService] [bg] Polling DeFindex for vault confirmation: ${predictedVaultAddress}`,
      );
      const confirmed = await this.defindex.waitForVaultConfirmation(predictedVaultAddress);
      if (!confirmed) {
        throw new Error(
          `[OnboardingService] Vault ${predictedVaultAddress} not confirmed by DeFindex API after polling.`,
        );
      }

      // Step 6: bind the vault in the Buffer contract (admin-signed)
      console.info(`[OnboardingService] [bg] Binding vault in Buffer contract`);
      const bindingTxHash = await this.bufferService.setUserVault(
        bufferContractId,
        stellarAddress,
        predictedVaultAddress,
      );
      console.info(
        `[OnboardingService] [bg] Vault bound: user=${userId} vault=${predictedVaultAddress} tx=${bindingTxHash}`,
      );

      // Step 7: mark user READY
      await this.supabase.updateUserOnboardingStatus(userId, "READY", {
        defindex_vault_address: predictedVaultAddress,
        buffer_contract_address: bufferContractId,
      });

      console.info(`[OnboardingService] [bg] Vault creation complete for user=${userId}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[OnboardingService] [bg] Vault creation failed for user=${userId}: ${message}`,
      );

      await this.supabase.updateUserOnboardingStatus(userId, "FAILED").catch((e: unknown) => {
        console.error("[OnboardingService] [bg] Failed to set status FAILED:", e);
      });

      await this.supabase
        .updateBufferTransactionStatus(txId, "FAILED", { error: message })
        .catch((e: unknown) => {
          console.error("[OnboardingService] [bg] Failed to mark buffer_transaction FAILED:", e);
        });

      // Re-throw so the controller's .catch() outer handler also fires (double-safety).
      // The outer handler's Supabase calls are .catch(()=>{}) so duplicate updates are harmless.
      throw err;
    }
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
