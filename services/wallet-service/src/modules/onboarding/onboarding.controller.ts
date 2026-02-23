import { type Request, type Response } from "express";
import { z } from "zod";
import { OnboardingService } from "./onboarding.service.js";
import { SupabaseService } from "../supabase/supabase.service.js";

const onboardSchema = z.object({
  userId: z.string().uuid(),
  email: z.string().email(),
});

const statusSchema = z.object({
  userId: z.string().uuid(),
});

const prepareVaultSchema = z.object({
  userId: z.string().uuid(),
});

const submitVaultSchema = z.object({
  userId: z.string().uuid(),
  txId: z.string().uuid(),
  transactionHash: z.string().min(1),
});

export class OnboardingController {
  constructor(
    private readonly onboardingService: OnboardingService,
    private readonly supabaseService: SupabaseService,
  ) {}

  private sendError(
    res: Response,
    statusCode: number,
    errorCode: string,
    message: string,
    details?: unknown,
  ): void {
    res.status(statusCode).json({ errorCode, message, details });
  }

  private resolveStatusFromMessage(message: string): { statusCode: number; errorCode: string } {
    const lower = message.toLowerCase();
    if (lower.includes("already has an active vault")) {
      return { statusCode: 409, errorCode: "VAULT_ALREADY_ACTIVE" };
    }
    if (lower.includes("no wallet address")) {
      return { statusCode: 409, errorCode: "WALLET_NOT_READY" };
    }
    if (lower.includes("missing predicted vault address")) {
      return { statusCode: 409, errorCode: "VAULT_SUBMIT_INVALID_STATE" };
    }
    if (lower.includes("not confirmed")) {
      return { statusCode: 409, errorCode: "VAULT_NOT_CONFIRMED" };
    }
    return { statusCode: 500, errorCode: "ONBOARDING_INTERNAL_ERROR" };
  }

  async onboard(req: Request, res: Response): Promise<void> {
    try {
      const { userId, email } = onboardSchema.parse(req.body);
      const result = await this.onboardingService.onboardUser(userId, email);
      res.json(result);
    } catch (error: unknown) {
      if (error instanceof z.ZodError) {
        this.sendError(res, 400, "INVALID_REQUEST", "Invalid request payload.", error.flatten());
        return;
      }
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`[OnboardingController] onboard failed: ${message}`);
      const resolved = this.resolveStatusFromMessage(message);
      this.sendError(res, resolved.statusCode, resolved.errorCode, "Onboarding failed");
    }
  }

  async getStatus(req: Request, res: Response): Promise<void> {
    try {
      const { userId } = statusSchema.parse(req.body);

      try {
        const user = await this.supabaseService.getUser(userId);
        res.json({
          userId,
          status: user.buffer_onboarding_status ?? "PENDING",
          stellarAddress: user.stellar_address ?? null,
          vaultAddress: user.defindex_vault_address ?? null,
        });
      } catch {
        res.json({ userId, status: "NOT_STARTED" });
      }
    } catch (error: unknown) {
      if (error instanceof z.ZodError) {
        this.sendError(res, 400, "INVALID_REQUEST", "Invalid request payload.", error.flatten());
        return;
      }
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`[OnboardingController] getStatus failed: ${message}`);
      this.sendError(res, 500, "STATUS_FETCH_FAILED", "Failed to get onboarding status");
    }
  }

  async prepareVault(req: Request, res: Response): Promise<void> {
    try {
      const { userId } = prepareVaultSchema.parse(req.body);
      const result = await this.onboardingService.prepareVaultCreation(userId);
      res.json(result);
    } catch (error: unknown) {
      if (error instanceof z.ZodError) {
        this.sendError(res, 400, "INVALID_REQUEST", "Invalid request payload.", error.flatten());
        return;
      }
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`[OnboardingController] prepareVault failed: ${message}`);
      const resolved = this.resolveStatusFromMessage(message);
      this.sendError(
        res,
        resolved.statusCode,
        resolved.errorCode,
        "Failed to prepare vault creation",
      );
    }
  }

  async submitVault(req: Request, res: Response): Promise<void> {
    try {
      const { userId, txId, transactionHash } = submitVaultSchema.parse(req.body);
      const result = await this.onboardingService.submitVaultCreation(userId, txId, transactionHash);
      res.json(result);
    } catch (error: unknown) {
      if (error instanceof z.ZodError) {
        this.sendError(res, 400, "INVALID_REQUEST", "Invalid request payload.", error.flatten());
        return;
      }
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`[OnboardingController] submitVault failed: ${message}`);
      const resolved = this.resolveStatusFromMessage(message);
      this.sendError(
        res,
        resolved.statusCode,
        resolved.errorCode,
        "Failed to submit vault creation",
      );
    }
  }
}
