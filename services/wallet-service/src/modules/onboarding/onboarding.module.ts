import { Module } from "@nestjs/common";
import { OnboardingController } from "./onboarding.controller.js";
import { OnboardingService } from "./onboarding.service.js";
import { OnboardingStartupService } from "./onboarding-startup.service.js";

@Module({
  controllers: [OnboardingController],
  providers: [OnboardingService, OnboardingStartupService],
})
export class OnboardingModule {}
