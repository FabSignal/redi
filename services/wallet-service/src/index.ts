import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// dotenv MUST load before any service instantiation
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: true });

// All service/route imports happen AFTER dotenv
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { getServerEnv } from "@redi/config";

import { SupabaseService } from "./modules/supabase/supabase.service.js";
import { CrossmintService } from "./modules/crossmint/crossmint.service.js";
import { DeFindexService } from "./modules/defindex/defindex.service.js";
import { BufferService } from "./modules/buffer/buffer.service.js";
import { OnboardingService } from "./modules/onboarding/onboarding.service.js";
import { BufferController } from "./modules/buffer/buffer.controller.js";
import { OnboardingController } from "./modules/onboarding/onboarding.controller.js";
import { createBufferWalletRouter } from "./routes/buffer-wallet.js";
import stellarWalletRoutes from "./routes/stellar-wallet.js";

// Composition root — single place where all services are instantiated
const supabaseService = new SupabaseService();
const crossmintService = new CrossmintService();
const defindexService = new DeFindexService();
const bufferService = new BufferService();
const onboardingService = new OnboardingService(supabaseService, crossmintService, defindexService);
const bufferController = new BufferController(bufferService, supabaseService);
const onboardingController = new OnboardingController(onboardingService, supabaseService);

const env = getServerEnv();
const app = express();

app.use(helmet());
app.use(cors({ origin: "http://localhost:3000", credentials: false }));
app.use(express.json({ limit: "1mb" }));
app.use(
  pinoHttp({
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers.x-api-key",
        "res.headers.set-cookie",
      ],
      censor: "[REDACTED]",
    },
  }),
);

app.get("/health", (_req, res) => {
  res.json({
    service: "wallet-service",
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

app.use("/api/buffer", createBufferWalletRouter(bufferController, onboardingController, crossmintService));
app.use("/api/buffer", stellarWalletRoutes);

app.listen(env.WALLET_SERVICE_PORT, () => {
  process.stdout.write(`wallet-service listening on http://localhost:${env.WALLET_SERVICE_PORT}\n`);
});
