import { Router } from "express";
import { z } from "zod";
import { getOrCreateWalletByEmail, getWalletBalanceByEmail } from "@redi/crossmint";
import { BufferController } from "../modules/buffer/buffer.controller.js";
import { BufferService } from "../modules/buffer/buffer.service.js";
import { SupabaseService } from "../modules/supabase/supabase.service.js";
import { CrossmintService } from "../modules/crossmint/crossmint.service.js";
import { OnboardingController } from "../modules/onboarding/onboarding.controller.js";
import { OnboardingService } from "../modules/onboarding/onboarding.service.js";
import { DeFindexService } from "../modules/defindex/defindex.service.js";

const router = Router();

const emailSchema = z.object({
  email: z.string().email(),
});

const supabaseService = new SupabaseService();
const crossmintService = new CrossmintService();
const defindexService = new DeFindexService();
const bufferService = new BufferService();
const onboardingService = new OnboardingService(supabaseService, crossmintService, defindexService);

const bufferController = new BufferController(bufferService, supabaseService, crossmintService);
const onboardingController = new OnboardingController(onboardingService);

router.post("/wallet/provision", async (req, res) => {
  try {
    const { email } = emailSchema.parse(req.body);
    const wallet = await getOrCreateWalletByEmail(email, "stellar-testnet");
    return res.json(wallet);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid request", details: error.flatten() });
    }
    return res.status(500).json({ error: "Failed to provision wallet" });
  }
});

router.post("/wallet/state", async (req, res) => {
  try {
    const { email } = emailSchema.parse(req.body);
    const balance = await getWalletBalanceByEmail(email, "stellar-testnet");
    return res.json(balance);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid request", details: error.flatten() });
    }
    return res.status(500).json({ error: "Failed to get wallet state" });
  }
});

router.post("/onboarding", (req, res) => onboardingController.onboard(req, res));
router.post("/onboarding/status", (req, res) => onboardingController.getStatus(req, res));

router.post("/balance", (req, res) => bufferController.getBalance(req, res));

router.post("/deposit/prepare", (req, res) => bufferController.prepareDeposit(req, res));
router.post("/deposit/submit", (req, res) => bufferController.submitDeposit(req, res));

router.post("/withdraw/prepare", (req, res) => bufferController.prepareWithdraw(req, res));
router.post("/withdraw/submit", (req, res) => bufferController.submitWithdraw(req, res));

export default router;
