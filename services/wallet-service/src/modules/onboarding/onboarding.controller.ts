import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from "@nestjs/common";
import { IsEmail, IsUUID } from "class-validator";
import { OnboardingService } from "./onboarding.service.js";

class OnboardDto {
  @IsUUID()
  userId!: string;

  @IsEmail()
  email!: string;
}

class OnboardingStatusDto {
  @IsUUID()
  userId!: string;
}

class CreateVaultDto {
  @IsUUID()
  userId!: string;
}

@Controller("/api/buffer")
export class OnboardingController {
  constructor(private readonly onboardingService: OnboardingService) {}

  @Post("/onboarding")
  onboard(@Body() dto: OnboardDto) {
    return this.onboardingService.onboardUser(dto.userId, dto.email);
  }

  @Post("/onboarding/status")
  getStatusPost(@Body() dto: OnboardingStatusDto) {
    return this.onboardingService.getStatus(dto.userId);
  }

  @Get("/onboarding/status")
  getStatusGet(@Query() dto: OnboardingStatusDto) {
    return this.onboardingService.getStatus(dto.userId);
  }

  @Post("/onboarding/vault/create")
  @HttpCode(HttpStatus.ACCEPTED)
  createVault(@Body() dto: CreateVaultDto) {
    return this.onboardingService.queueVaultCreation(dto.userId);
  }
}
