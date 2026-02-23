import { Router } from "express";
import { z } from "zod";
import { BufferController } from "../modules/buffer/buffer.controller.js";
import { OnboardingController } from "../modules/onboarding/onboarding.controller.js";
import { CrossmintService } from "../modules/crossmint/crossmint.service.js";

const emailSchema = z.object({
  email: z.string().email(),
});

export function createBufferWalletRouter(
  bufferController: BufferController,
  onboardingController: OnboardingController,
  crossmintService: CrossmintService,
): Router {
  const router = Router();

  router.post("/wallet/provision", async (req, res) => {
    try {
      const { email } = emailSchema.parse(req.body);
      const wallet = await crossmintService.createWalletForUser(email);

      return res.json({
        address: wallet.address,
        walletLocator: wallet.walletId,
        chain: wallet.chain,
        type: "smart",
      });
    } catch (error: unknown) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid request", details: error.flatten() });
      }
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`[buffer-wallet] wallet/provision error: ${message}`);
      return res.status(500).json({ error: "Failed to provision wallet" });
    }
  });

  router.post("/wallet/state", async (req, res) => {
    try {
      const { email } = emailSchema.parse(req.body);
      const balances = await crossmintService.getWalletBalances(email);
      return res.json(balances);
    } catch (error: unknown) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid request", details: error.flatten() });
      }
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`[buffer-wallet] wallet/state error: ${message}`);
      return res.status(500).json({ error: "Failed to get wallet state" });
    }
  });

  router.post("/onboarding", (req, res) => onboardingController.onboard(req, res));
  router.post("/onboarding/status", (req, res) => onboardingController.getStatus(req, res));
  router.post("/onboarding/vault/prepare", (req, res) => onboardingController.prepareVault(req, res));
  router.post("/onboarding/vault/submit", (req, res) => onboardingController.submitVault(req, res));

  router.post("/balance", (req, res) => bufferController.getBalance(req, res));

  router.post("/deposit/prepare", (req, res) => bufferController.prepareDeposit(req, res));
  router.post("/deposit/submit", (req, res) => bufferController.submitDeposit(req, res));

  router.post("/withdraw/prepare", (req, res) => bufferController.prepareWithdraw(req, res));
  router.post("/withdraw/submit", (req, res) => bufferController.submitWithdraw(req, res));

  return router;
}
