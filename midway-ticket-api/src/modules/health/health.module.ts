import { Controller, Get } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Module } from "@nestjs/common";

@ApiTags("health")
@Controller("health")
export class HealthController {
  @Get()
  check() {
    return {
      status: "ok",
      service: "midway-ticket-api",
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV ?? "development",
    };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
