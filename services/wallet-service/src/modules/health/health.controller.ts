import { Controller, Get } from "@nestjs/common";

@Controller()
export class HealthController {
  @Get("/health")
  getHealth() {
    return {
      service: "wallet-service",
      status: "ok",
      timestamp: new Date().toISOString(),
    };
  }
}
