import { type Request, type Response } from "express";
import { z } from "zod";
import { BufferService } from "./buffer.service.js";
import { SupabaseService } from "../supabase/supabase.service.js";
import { CrossmintService } from "../crossmint/crossmint.service.js";

const getBalanceSchema = z.object({
  userId: z.string().uuid(),
});

const depositSchema = z.object({
  userId: z.string().uuid(),
  amountStroops: z.string().regex(/^\d+$/, "Must be a numeric string"),
});

const withdrawSchema = z.object({
  userId: z.string().uuid(),
  sharesAmount: z.string().regex(/^\d+$/, "Must be a numeric string"),
});

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

type ApiError = {
  errorCode: string;
  message: string;
  details?: unknown;
};

export class BufferController {
  constructor(
    private readonly bufferService: BufferService,
    private readonly supabaseService: SupabaseService,
    private readonly crossmintService: CrossmintService,
  ) {}

  private sendError(
    res: Response,
    statusCode: number,
    errorCode: string,
    message: string,
    details?: unknown,
  ): void {
    const payload: ApiError = { errorCode, message, details };
    res.status(statusCode).json(payload);
  }

  private resolveBufferContractId(userBufferContractAddress: string | null): string | null {
    const configuredContractId = process.env.BUFFER_CONTRACT_ID ?? null;
    if (configuredContractId) {
      return configuredContractId;
    }
    return userBufferContractAddress;
  }

  async getBalance(req: Request, res: Response): Promise<void> {
    try {
      const { userId } = getBalanceSchema.parse(req.body);
      const user = await this.supabaseService.getUserBufferConfig(userId);

      if (!user.stellarAddress) {
        this.sendError(
          res,
          409,
          "ONBOARDING_INCOMPLETE",
          "User has no stellar address. Complete onboarding first.",
        );
        return;
      }

      if (!user.defindexVaultAddress || user.onboardingStatus !== "READY") {
        this.sendError(
          res,
          409,
          "VAULT_NOT_READY",
          "User vault not ready. Complete first vault signature before depositing.",
        );
        return;
      }

      const bufferContractId = this.resolveBufferContractId(user.bufferContractAddress);
      if (!bufferContractId) {
        this.sendError(
          res,
          409,
          "BUFFER_CONTRACT_NOT_AVAILABLE",
          "No buffer contract available for this user.",
        );
        return;
      }

      const balance = await this.bufferService.getBalance(bufferContractId, user.stellarAddress);
      res.json({ userId, balance });
    } catch (error: unknown) {
      if (error instanceof z.ZodError) {
        this.sendError(res, 400, "INVALID_REQUEST", "Invalid request payload.", error.flatten());
        return;
      }
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`[BufferController] getBalance failed: ${message}`);
      this.sendError(res, 500, "BALANCE_FETCH_FAILED", "Failed to get buffer balance");
    }
  }

  async prepareDeposit(req: Request, res: Response): Promise<void> {
    try {
      const { userId, amountStroops } = depositSchema.parse(req.body);
      console.info(`[BufferController] prepareDeposit start: userId=${userId} amount=${amountStroops}`);
      const user = await this.supabaseService.getUserBufferConfig(userId);

      if (!user.stellarAddress) {
        this.sendError(
          res,
          409,
          "ONBOARDING_INCOMPLETE",
          "User has no stellar address. Complete onboarding first.",
        );
        return;
      }

      if (!user.defindexVaultAddress || user.onboardingStatus !== "READY") {
        this.sendError(
          res,
          409,
          "VAULT_NOT_READY",
          "User vault not ready. Complete first vault signature before depositing.",
        );
        return;
      }

      const bufferContractId = this.resolveBufferContractId(user.bufferContractAddress);
      if (!bufferContractId) {
        this.sendError(
          res,
          409,
          "BUFFER_CONTRACT_NOT_AVAILABLE",
          "No buffer contract available for this user.",
        );
        return;
      }

      const transactionXDR = await this.bufferService.buildDepositTransaction(
        bufferContractId,
        user.stellarAddress,
        amountStroops,
      );

      const txId = await this.supabaseService.createBufferTransaction({
        userId,
        transactionType: "DEPOSIT",
        amountStroops,
        status: "PENDING",
        metadata: { bufferContractId, walletAddress: user.stellarAddress },
      });

      const profile = await this.supabaseService.getUser(userId);
      const signerEmail =
        typeof profile.email === "string" && profile.email.length > 0 ? profile.email : null;
      if (!signerEmail) {
        this.sendError(
          res,
          409,
          "MISSING_SIGNER_EMAIL",
          "User email is required to create Crossmint transaction.",
        );
        return;
      }

      const crossmintTransaction = await this.crossmintService.createUserTransaction({
        walletAddress: user.stellarAddress,
        signerEmail,
        transactionXDR,
        contractId: bufferContractId,
        method: "deposit",
        args: { user: user.stellarAddress, amount: amountStroops },
      });

      console.info(`[BufferController] prepareDeposit success: userId=${userId} txId=${txId}`);
      res.json({
        txId,
        transactionXDR,
        walletAddress: user.stellarAddress,
        bufferContractId,
        crossmintTransactionId: crossmintTransaction.transactionId,
        method: "deposit",
        args: { user: user.stellarAddress, amount: amountStroops },
      });
    } catch (error: unknown) {
      if (error instanceof z.ZodError) {
        this.sendError(res, 400, "INVALID_REQUEST", "Invalid request payload.", error.flatten());
        return;
      }
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`[BufferController] prepareDeposit failed: ${message}`);
      this.sendError(res, 500, "DEPOSIT_PREPARE_FAILED", "Failed to prepare deposit transaction");
    }
  }

  async submitDeposit(req: Request, res: Response): Promise<void> {
    try {
      const parsed = confirmSchema.safeParse(req.body);
      if (!parsed.success) {
        const legacyParsed = legacySubmitSchema.safeParse(req.body);
        if (legacyParsed.success) {
          this.sendError(
            res,
            409,
            "USER_SIGNATURE_REQUIRED",
            "Server-side signing is disabled for user fund movements. Submit a user-signed transaction hash.",
          );
          return;
        }
        this.sendError(res, 400, "INVALID_REQUEST", "Invalid request payload.", parsed.error.flatten());
        return;
      }
      const { userId, txId, transactionHash } = parsed.data;
      console.info(`[BufferController] submitDeposit start: userId=${userId} txId=${txId}`);

      try {
        const existing = await this.supabaseService.getBufferTransactionForUser(userId, txId);
        if (existing.status === "CONFIRMED") {
          console.info(`[BufferController] submitDeposit idempotent hit: txId=${txId}`);
          res.json({ txId, transactionHash: existing.stellarTxHash ?? transactionHash, status: "CONFIRMED" });
          return;
        }
      } catch {
      }

      await this.supabaseService.confirmBufferTransactionForUser(userId, txId, transactionHash);
      console.info(`[BufferController] submitDeposit success: txId=${txId} hash=${transactionHash}`);
      res.json({ txId, transactionHash, status: "CONFIRMED" });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`[BufferController] submitDeposit failed: ${message}`);
      this.sendError(res, 500, "DEPOSIT_CONFIRM_FAILED", "Failed to confirm deposit transaction");
    }
  }

  async prepareWithdraw(req: Request, res: Response): Promise<void> {
    try {
      const { userId, sharesAmount } = withdrawSchema.parse(req.body);
      console.info(`[BufferController] prepareWithdraw start: userId=${userId} shares=${sharesAmount}`);
      const user = await this.supabaseService.getUserBufferConfig(userId);

      if (!user.stellarAddress) {
        this.sendError(
          res,
          409,
          "ONBOARDING_INCOMPLETE",
          "User has no stellar address. Complete onboarding first.",
        );
        return;
      }

      if (!user.defindexVaultAddress || user.onboardingStatus !== "READY") {
        this.sendError(
          res,
          409,
          "VAULT_NOT_READY",
          "User vault not ready. Complete first vault signature before withdrawing.",
        );
        return;
      }

      const bufferContractId = this.resolveBufferContractId(user.bufferContractAddress);
      if (!bufferContractId) {
        this.sendError(
          res,
          409,
          "BUFFER_CONTRACT_NOT_AVAILABLE",
          "No buffer contract available for this user.",
        );
        return;
      }

      const transactionXDR = await this.bufferService.buildWithdrawTransaction(
        bufferContractId,
        user.stellarAddress,
        sharesAmount,
      );

      const txId = await this.supabaseService.createBufferTransaction({
        userId,
        transactionType: "WITHDRAW",
        sharesDelta: sharesAmount,
        status: "PENDING",
        metadata: { bufferContractId, walletAddress: user.stellarAddress },
      });

      const profile = await this.supabaseService.getUser(userId);
      const signerEmail =
        typeof profile.email === "string" && profile.email.length > 0 ? profile.email : null;
      if (!signerEmail) {
        this.sendError(
          res,
          409,
          "MISSING_SIGNER_EMAIL",
          "User email is required to create Crossmint transaction.",
        );
        return;
      }

      const crossmintTransaction = await this.crossmintService.createUserTransaction({
        walletAddress: user.stellarAddress,
        signerEmail,
        transactionXDR,
        contractId: bufferContractId,
        method: "withdraw_available",
        args: { user: user.stellarAddress, shares: sharesAmount, to: user.stellarAddress },
      });

      console.info(`[BufferController] prepareWithdraw success: userId=${userId} txId=${txId}`);
      res.json({
        txId,
        transactionXDR,
        walletAddress: user.stellarAddress,
        bufferContractId,
        crossmintTransactionId: crossmintTransaction.transactionId,
        method: "withdraw_available",
        args: { user: user.stellarAddress, shares: sharesAmount, to: user.stellarAddress },
      });
    } catch (error: unknown) {
      if (error instanceof z.ZodError) {
        this.sendError(res, 400, "INVALID_REQUEST", "Invalid request payload.", error.flatten());
        return;
      }
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`[BufferController] prepareWithdraw failed: ${message}`);
      this.sendError(res, 500, "WITHDRAW_PREPARE_FAILED", "Failed to prepare withdraw transaction");
    }
  }

  async submitWithdraw(req: Request, res: Response): Promise<void> {
    try {
      const parsed = confirmSchema.safeParse(req.body);
      if (!parsed.success) {
        const legacyParsed = legacySubmitSchema.safeParse(req.body);
        if (legacyParsed.success) {
          this.sendError(
            res,
            409,
            "USER_SIGNATURE_REQUIRED",
            "Server-side signing is disabled for user fund movements. Submit a user-signed transaction hash.",
          );
          return;
        }
        this.sendError(res, 400, "INVALID_REQUEST", "Invalid request payload.", parsed.error.flatten());
        return;
      }
      const { userId, txId, transactionHash } = parsed.data;
      console.info(`[BufferController] submitWithdraw start: userId=${userId} txId=${txId}`);

      try {
        const existing = await this.supabaseService.getBufferTransactionForUser(userId, txId);
        if (existing.status === "CONFIRMED") {
          console.info(`[BufferController] submitWithdraw idempotent hit: txId=${txId}`);
          res.json({ txId, transactionHash: existing.stellarTxHash ?? transactionHash, status: "CONFIRMED" });
          return;
        }
      } catch {
      }

      await this.supabaseService.confirmBufferTransactionForUser(userId, txId, transactionHash);
      console.info(`[BufferController] submitWithdraw success: txId=${txId} hash=${transactionHash}`);
      res.json({ txId, transactionHash, status: "CONFIRMED" });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`[BufferController] submitWithdraw failed: ${message}`);
      this.sendError(res, 500, "WITHDRAW_CONFIRM_FAILED", "Failed to confirm withdraw transaction");
    }
  }
}
