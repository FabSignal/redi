import { Injectable, OnApplicationBootstrap } from "@nestjs/common";
import { appLogger } from "../../logger.js";
import { SupabaseService } from "../supabase/supabase.service.js";

@Injectable()
export class OnboardingStartupService implements OnApplicationBootstrap {
  constructor(private readonly supabaseService: SupabaseService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.supabaseService.failStuckVaultCreations().catch((err: unknown) => {
      appLogger.error({ err }, "startup.fail_stuck_vault_creations_failed");
    });
  }
}
