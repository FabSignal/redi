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
import { getServerEnv } from "@redi/config";
import { appLogger, loggerMiddleware } from "./logger.js";

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
const onboardingService = new OnboardingService(
  supabaseService,
  crossmintService,
  defindexService,
  bufferService,
);
const bufferController = new BufferController(bufferService, supabaseService, crossmintService);
const onboardingController = new OnboardingController(onboardingService, supabaseService);

const env = getServerEnv();
const app = express();

const allowedOrigins = new Set(
  (process.env.CORS_ALLOWED_ORIGINS ?? "http://localhost:3000,http://localhost:3001,http://localhost:3002")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
);

app.use(helmet());
app.use(
  cors({
    credentials: false,
    origin(origin, callback) {
      // No Origin header → server-to-server or curl → allow
      if (!origin) return callback(null, true);
      if (allowedOrigins.has(origin)) return callback(null, true);
      callback(new Error(`CORS: origin not allowed: ${origin}`));
    },
  }),
);
app.use(express.json({ limit: "1mb" }));
app.use(loggerMiddleware);

app.get("/health", (_req, res) => {
  res.json({
    service: "wallet-service",
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

app.use("/api/buffer", createBufferWalletRouter(bufferController, onboardingController, crossmintService));
app.use("/api/buffer", stellarWalletRoutes);

// Startup recovery: if wallet-service restarted while a vault creation background
// job was running, those users are stuck in VAULT_CREATING with no job to finish them.
// Mark them FAILED so they can retry via /vault/create.
void supabaseService.failStuckVaultCreations().catch((err: unknown) => {
  appLogger.error({ err }, "startup.fail_stuck_vault_creations_failed");
});

app.listen(env.WALLET_SERVICE_PORT, () => {
  appLogger.info(
    { port: env.WALLET_SERVICE_PORT, service: "wallet-service" },
    "wallet-service listening",
  );
});
