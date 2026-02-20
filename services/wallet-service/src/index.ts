import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { getServerEnv } from "@redi/config";
import { SupabaseService } from "./modules/supabase/supabase.service.js"; // ← import de la CLASE
import bufferWalletRoutes from "./routes/buffer-wallet.js";
import stellarWalletRoutes from "./routes/stellar-wallet.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: true });

export const supabaseService = new SupabaseService();

const env = getServerEnv();
const app = express();

app.use(helmet());
app.use(cors({ origin: true, credentials: false }));
app.use(express.json({ limit: "1mb" }));
app.use(pinoHttp());

app.get("/health", (_req, res) => {
  res.json({
    service: "wallet-service",
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

app.use("/api/buffer", bufferWalletRoutes);
app.use("/api/buffer", stellarWalletRoutes);

app.listen(env.WALLET_SERVICE_PORT, () => {
  process.stdout.write(`wallet-service listening on http://localhost:${env.WALLET_SERVICE_PORT}\n`);
});
