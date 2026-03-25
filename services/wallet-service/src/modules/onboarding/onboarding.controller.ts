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

const createVaultSchema = z.object({
  userId: z.string().uuid(),
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
      return { statusCode: 409, errorCode: "ALREADY_READY" };
    }
    if (lower.includes("vault creation already in progress")) {
      return { statusCode: 409, errorCode: "VAULT_IN_PROGRESS" };
    }
    if (lower.includes("no wallet address")) {
      return { statusCode: 409, errorCode: "WALLET_NOT_READY" };
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
      // Support both POST (body.userId) and GET (?userId=...) for the same handler.
      const { userId } = statusSchema.parse({ userId: req.body?.userId ?? req.query.userId });

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

  async createVault(req: Request, res: Response): Promise<void> {
    try {
      const { userId } = createVaultSchema.parse(req.body);
      const result = await this.onboardingService.startVaultCreation(userId);

      // Fire-and-forget: background job runs after 202 is sent.
      // The outer .catch() here is a final safety net in case runVaultCreationBackground
      // throws an uncaught error that escapes the method's own internal error handling.
      void this.onboardingService.runVaultCreationBackground(userId, result.txId).catch(
        async (err: unknown) => {
          const error = err instanceof Error ? err : new Error(String(err));
          console.error(
            `[OnboardingController] runVaultCreationBackground uncaught error: user=${userId} txId=${result.txId} err=${error.message}`,
          );
          await this.supabaseService
            .updateUserOnboardingStatus(userId, "FAILED")
            .catch(() => {});
          await this.supabaseService
            .updateBufferTransactionStatus(result.txId, "FAILED", { error: error.message })
            .catch(() => {});
        },
      );

      res.status(202).json(result);
    } catch (error: unknown) {
      if (error instanceof z.ZodError) {
        this.sendError(res, 400, "INVALID_REQUEST", "Invalid request payload.", error.flatten());
        return;
      }
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`[OnboardingController] createVault failed: ${message}`);
      const resolved = this.resolveStatusFromMessage(message);
      this.sendError(res, resolved.statusCode, resolved.errorCode, "Failed to start vault creation", {
        reason: message,
      });
    }
  }
}
