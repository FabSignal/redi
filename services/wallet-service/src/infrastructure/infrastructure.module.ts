import { Global, Module } from "@nestjs/common";
import { RuntimeConfigService } from "../common/config/runtime-config.service.js";
import { SupabaseService } from "../modules/supabase/supabase.service.js";
import { CrossmintService } from "../modules/crossmint/crossmint.service.js";
import { DeFindexService } from "../modules/defindex/defindex.service.js";
import { BufferService } from "../modules/buffer/buffer.service.js";

@Global()
@Module({
  providers: [
    RuntimeConfigService,
    SupabaseService,
    CrossmintService,
    DeFindexService,
    BufferService,
  ],
  exports: [
    RuntimeConfigService,
    SupabaseService,
    CrossmintService,
    DeFindexService,
    BufferService,
  ],
})
export class InfrastructureModule {}
