import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { validateEnvironment } from "./common/config/environment.js";
import { RuntimeConfigService } from "./common/config/runtime-config.service.js";
import { AppExceptionFilter } from "./common/filters/app-exception.filter.js";
import { InfrastructureModule } from "./infrastructure/infrastructure.module.js";
import { HealthModule } from "./modules/health/health.module.js";
import { OnboardingModule } from "./modules/onboarding/onboarding.module.js";
import { WalletModule } from "./modules/wallet/wallet.module.js";
import { BufferModule } from "./modules/buffer/buffer.module.js";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      validate: validateEnvironment,
    }),
    InfrastructureModule,
    HealthModule,
    WalletModule,
    OnboardingModule,
    BufferModule,
  ],
  providers: [RuntimeConfigService, AppExceptionFilter],
})
export class AppModule {}
