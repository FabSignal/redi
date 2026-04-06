import { z } from "zod";

export const environmentSchema = z.object({
  WALLET_SERVICE_PORT: z.coerce.number().int().positive().default(4103),
  CORS_ALLOWED_ORIGINS: z
    .string()
    .default("http://localhost:3000,http://localhost:3001,http://localhost:3002"),
  STELLAR_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  STELLAR_HORIZON_URL: z.string().url().default("https://horizon-testnet.stellar.org"),
  STELLAR_SOROBAN_RPC_URL: z.string().url(),
  ADMIN_STELLAR_SECRET: z.string().min(1),
  ADMIN_STELLAR_ADDRESS: z.string().min(1),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  CROSSMINT_API_KEY: z.string().min(1),
  CROSSMINT_BASE_URL: z.string().url().default("https://staging.crossmint.com"),
  DEFINDEX_API_URL: z.string().url(),
  DEFINDEX_API_KEY: z.string().min(1),
  BUFFER_CONTRACT_ID: z.string().min(1).optional(),
  XLM_CONTRACT_ADDRESS: z.string().min(1),
  XLM_BLEND_STRATEGY: z.string().min(1),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Environment = z.infer<typeof environmentSchema>;

export function validateEnvironment(source: Record<string, unknown>): Environment {
  const parsed = environmentSchema.safeParse(source);
  if (parsed.success) {
    return parsed.data;
  }

  throw new Error(`Invalid environment: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
}
