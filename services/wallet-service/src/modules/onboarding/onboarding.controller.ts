import { type Request, type Response } from "express";
import { z } from "zod";
import { OnboardingService } from "./onboarding.service.js";

const onboardSchema = z.object({
  userId: z.string().uuid(),
  email: z.string().email(),
});

const statusSchema = z.object({
  userId: z.string().uuid(),
});

export class OnboardingController {
  constructor(private readonly onboardingService: OnboardingService) {}

  // POST /api/buffer/onboarding
  async onboard(req: Request, res: Response): Promise<void> {
    try {
      const { userId, email } = onboardSchema.parse(req.body);
      const result = await this.onboardingService.onboardUser(userId, email);
      res.json(result);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid request", details: error.flatten() });
        return;
      }
      console.error(`[OnboardingController] onboard failed: ${error.message}`);
      res.status(500).json({ error: "Onboarding failed" });
    }
  }

  // POST /api/buffer/onboarding/status
  async getStatus(req: Request, res: Response): Promise<void> {
    try {
      const { userId } = statusSchema.parse(req.body);
      const result = await this.onboardingService.onboardUser(userId, "");
      res.json({ userId, status: result.status });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid request", details: error.flatten() });
        return;
      }
      console.error(`[OnboardingController] getStatus failed: ${error.message}`);
      res.status(500).json({ error: "Failed to get onboarding status" });
    }
  }
}
