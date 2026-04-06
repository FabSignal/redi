import { Injectable } from "@nestjs/common";
import { Networks, Transaction } from "@stellar/stellar-sdk";
import { z } from "zod";
import { AppError } from "../../common/errors/app-error.js";
import { RuntimeConfigService } from "../../common/config/runtime-config.service.js";
import { structuredLog } from "../../utils/structured-log.js";
import { CrossmintService } from "../crossmint/crossmint.service.js";
import { SupabaseService } from "../supabase/supabase.service.js";
import { BufferService } from "./buffer.service.js";

const confirmSchema = z.object({
  userId: z.string().uuid(),
  txId: z.string().uuid(),
  transactionHash: z.string().min(1),
});

const legacySubmitSchema = z.object({
  userId: z.string().uuid(),
  txId: z.string().uuid(),
  walletLocator: z.string().min(1),
  transactionXDR: z.string().min(1),
});

@Injectable()
export class BufferApplicationService {
  constructor(
    private readonly bufferService: BufferService,
    private readonly supabaseService: SupabaseService,
    private readonly crossmintService: CrossmintService,
    private readonly runtimeConfig: RuntimeConfigService,
  ) {}

  private resolveBufferContractId(userBufferContractAddress: string | null): string | null {
    return this.runtimeConfig.bufferContractId ?? userBufferContractAddress;
  }

  private getNetworkPassphrase(): string {
    return this.runtimeConfig.stellarNetwork === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
  }

  private extractTransactionFeeStroops(transactionXDR: string): string | null {
    try {
      const tx = new Transaction(transactionXDR, this.getNetworkPassphrase());
      return tx.fee;
    } catch {
      return null;
    }
  }

  private resolveFeePayer(walletAddress: string): "platform" | "user" {
    return walletAddress.startsWith("C") ? "platform" : "user";
  }

  private async getReadyUser(userId: string, action: "balance" | "deposit" | "withdraw") {
    const user = await this.supabaseService.getUserBufferConfig(userId);

    if (!user.stellarAddress) {
      throw new AppError(
        "ONBOARDING_INCOMPLETE",
        409,
        "User has no stellar address. Complete onboarding first.",
      );
    }

    if (!user.defindexVaultAddress || user.onboardingStatus !== "READY") {
      throw new AppError(
        "VAULT_NOT_READY",
        409,
        `User vault not ready. Complete first vault signature before ${action}.`,
      );
    }

    const bufferContractId = this.resolveBufferContractId(user.bufferContractAddress);
    if (!bufferContractId) {
      throw new AppError(
        "BUFFER_CONTRACT_NOT_AVAILABLE",
        409,
        "No buffer contract available for this user.",
      );
    }

    return {
      bufferContractId,
      stellarAddress: user.stellarAddress,
    };
  }

  private async getSignerEmail(userId: string): Promise<string> {
    const profile = await this.supabaseService.getUser(userId);
    const signerEmail =
      typeof profile.email === "string" && profile.email.length > 0 ? profile.email : null;

    if (!signerEmail) {
      throw new AppError(
        "MISSING_SIGNER_EMAIL",
        409,
        "User email is required to create Crossmint transaction.",
      );
    }

    return signerEmail;
  }

  private parseConfirmationPayload(payload: unknown) {
    const parsed = confirmSchema.safeParse(payload);
    if (parsed.success) {
      return parsed.data;
    }

    const legacyParsed = legacySubmitSchema.safeParse(payload);
    if (legacyParsed.success) {
      throw new AppError(
        "USER_SIGNATURE_REQUIRED",
        409,
        "Server-side signing is disabled for user fund movements. Submit a user-signed transaction hash.",
      );
    }

    throw new AppError("INVALID_REQUEST", 400, "Invalid request payload.", parsed.error.flatten());
  }

  async getBalance(userId: string) {
    const user = await this.getReadyUser(userId, "balance");
    const balance = await this.bufferService.getBalance(user.bufferContractId, user.stellarAddress);

    structuredLog.info("BufferController", "buffer.balance", {
      userId,
      walletAddress: user.stellarAddress,
      bufferContractId: user.bufferContractId,
      balance: {
        availableShares: balance.availableShares,
        protectedShares: balance.protectedShares,
        availableValueStroops: balance.availableValue,
        protectedValueStroops: balance.protectedValue,
        totalValueStroops: balance.totalValue,
        totalDepositedStroops: balance.totalDeposited,
        lastDepositTs: balance.lastDepositTs,
        version: balance.version,
      },
    });

    return { userId, balance };
  }

  async prepareDeposit(userId: string, amountStroops: string) {
    structuredLog.info("BufferController", "buffer.deposit_prepare_start", {
      userId,
      principalStroops: amountStroops,
    });

    const user = await this.getReadyUser(userId, "deposit");
    const signerEmail = await this.getSignerEmail(userId);
    const transactionXDR = await this.bufferService.buildDepositTransaction(
      user.bufferContractId,
      user.stellarAddress,
      amountStroops,
    );
    const transactionFeeStroops = this.extractTransactionFeeStroops(transactionXDR);
    const feePayer = this.resolveFeePayer(user.stellarAddress);

    const txId = await this.supabaseService.createBufferTransaction({
      userId,
      transactionType: "DEPOSIT",
      amountStroops,
      status: "PENDING",
      metadata: {
        bufferContractId: user.bufferContractId,
        walletAddress: user.stellarAddress,
      },
    });

    const crossmintTransaction = await this.crossmintService.createUserTransaction({
      walletAddress: user.stellarAddress,
      signerEmail,
      transactionXDR,
      contractId: user.bufferContractId,
      method: "deposit",
      args: { user: user.stellarAddress, amount: amountStroops },
    });

    structuredLog.info("BufferController", "buffer.deposit_prepare_ready", {
      userId,
      txId,
      walletAddress: user.stellarAddress,
      bufferContractId: user.bufferContractId,
      principalStroops: amountStroops,
      creditedToBufferStroops: amountStroops,
      transactionFeeStroops,
      transactionFeePayer: feePayer,
      crossmintTransactionId: crossmintTransaction.transactionId,
    });

    return {
      txId,
      transactionXDR,
      walletAddress: user.stellarAddress,
      bufferContractId: user.bufferContractId,
      crossmintTransactionId: crossmintTransaction.transactionId,
      method: "deposit",
      args: { user: user.stellarAddress, amount: amountStroops },
    };
  }

  async confirmDeposit(payload: unknown) {
    const { userId, txId, transactionHash } = this.parseConfirmationPayload(payload);

    structuredLog.info("BufferController", "buffer.deposit_submit_start", {
      userId,
      txId,
    });

    try {
      const existing = await this.supabaseService.getBufferTransactionForUser(userId, txId);
      if (existing.status === "CONFIRMED") {
        return {
          txId,
          transactionHash: existing.stellarTxHash ?? transactionHash,
          status: "CONFIRMED",
        };
      }
    } catch {}

    await this.supabaseService.confirmBufferTransactionForUser(userId, txId, transactionHash);

    structuredLog.info("BufferController", "buffer.deposit_submit_confirmed", {
      userId,
      txId,
      transactionHash,
    });

    return { txId, transactionHash, status: "CONFIRMED" };
  }

  async prepareWithdraw(userId: string, sharesAmount: string) {
    structuredLog.info("BufferController", "buffer.withdraw_prepare_start", {
      userId,
      requestedShares: sharesAmount,
    });

    const user = await this.getReadyUser(userId, "withdraw");
    const signerEmail = await this.getSignerEmail(userId);
    const transactionXDR = await this.bufferService.buildWithdrawTransaction(
      user.bufferContractId,
      user.stellarAddress,
      sharesAmount,
    );
    const transactionFeeStroops = this.extractTransactionFeeStroops(transactionXDR);
    const feePayer = this.resolveFeePayer(user.stellarAddress);

    const txId = await this.supabaseService.createBufferTransaction({
      userId,
      transactionType: "WITHDRAW",
      sharesDelta: sharesAmount,
      status: "PENDING",
      metadata: {
        bufferContractId: user.bufferContractId,
        walletAddress: user.stellarAddress,
      },
    });

    const crossmintTransaction = await this.crossmintService.createUserTransaction({
      walletAddress: user.stellarAddress,
      signerEmail,
      transactionXDR,
      contractId: user.bufferContractId,
      method: "withdraw_available",
      args: {
        user: user.stellarAddress,
        shares: sharesAmount,
        to: user.stellarAddress,
      },
    });

    structuredLog.info("BufferController", "buffer.withdraw_prepare_ready", {
      userId,
      txId,
      walletAddress: user.stellarAddress,
      bufferContractId: user.bufferContractId,
      requestedShares: sharesAmount,
      transactionFeeStroops,
      transactionFeePayer: feePayer,
      crossmintTransactionId: crossmintTransaction.transactionId,
    });

    return {
      txId,
      transactionXDR,
      walletAddress: user.stellarAddress,
      bufferContractId: user.bufferContractId,
      crossmintTransactionId: crossmintTransaction.transactionId,
      method: "withdraw_available",
      args: {
        user: user.stellarAddress,
        shares: sharesAmount,
        to: user.stellarAddress,
      },
    };
  }

  async confirmWithdraw(payload: unknown) {
    const { userId, txId, transactionHash } = this.parseConfirmationPayload(payload);

    structuredLog.info("BufferController", "buffer.withdraw_submit_start", {
      userId,
      txId,
    });

    try {
      const existing = await this.supabaseService.getBufferTransactionForUser(userId, txId);
      if (existing.status === "CONFIRMED") {
        return {
          txId,
          transactionHash: existing.stellarTxHash ?? transactionHash,
          status: "CONFIRMED",
        };
      }
    } catch {}

    await this.supabaseService.confirmBufferTransactionForUser(userId, txId, transactionHash);

    structuredLog.info("BufferController", "buffer.withdraw_submit_confirmed", {
      userId,
      txId,
      transactionHash,
    });

    return { txId, transactionHash, status: "CONFIRMED" };
  }
}
