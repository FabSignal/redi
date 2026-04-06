import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Environment } from "./environment.js";

@Injectable()
export class RuntimeConfigService {
  constructor(private readonly configService: ConfigService<Environment, true>) {}

  get walletServicePort(): number {
    return this.configService.get("WALLET_SERVICE_PORT", { infer: true })!;
  }

  get corsAllowedOrigins(): string[] {
    const raw = this.configService.get("CORS_ALLOWED_ORIGINS", { infer: true })!;
    return raw
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean);
  }

  get stellarNetwork(): "testnet" | "mainnet" {
    return this.configService.get("STELLAR_NETWORK", { infer: true })!;
  }

  get stellarHorizonUrl(): string {
    return this.configService.get("STELLAR_HORIZON_URL", { infer: true })!;
  }

  get stellarSorobanRpcUrl(): string {
    return this.configService.get("STELLAR_SOROBAN_RPC_URL", { infer: true })!;
  }

  get adminStellarSecret(): string {
    return this.configService.get("ADMIN_STELLAR_SECRET", { infer: true })!;
  }

  get adminStellarAddress(): string {
    return this.configService.get("ADMIN_STELLAR_ADDRESS", { infer: true })!;
  }

  get supabaseUrl(): string {
    return this.configService.get("SUPABASE_URL", { infer: true })!;
  }

  get supabaseServiceRoleKey(): string {
    return this.configService.get("SUPABASE_SERVICE_ROLE_KEY", { infer: true })!;
  }

  get crossmintApiKey(): string {
    return this.configService.get("CROSSMINT_API_KEY", { infer: true })!;
  }

  get crossmintBaseUrl(): string {
    return this.configService.get("CROSSMINT_BASE_URL", { infer: true })!;
  }

  get defindexApiUrl(): string {
    return this.configService.get("DEFINDEX_API_URL", { infer: true })!;
  }

  get defindexApiKey(): string {
    return this.configService.get("DEFINDEX_API_KEY", { infer: true })!;
  }

  get bufferContractId(): string | null {
    return this.configService.get("BUFFER_CONTRACT_ID", { infer: true }) ?? null;
  }

  get xlmContractAddress(): string {
    return this.configService.get("XLM_CONTRACT_ADDRESS", { infer: true })!;
  }

  get xlmBlendStrategy(): string {
    return this.configService.get("XLM_BLEND_STRATEGY", { infer: true })!;
  }
}
