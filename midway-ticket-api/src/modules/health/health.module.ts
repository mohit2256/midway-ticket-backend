import { Controller, Get, VERSION_NEUTRAL } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Module } from "@nestjs/common";

// VERSION_NEUTRAL: main.ts applies URI versioning (defaultVersion: "1") to
// every controller by default, which would otherwise make this route
// /api/v1/health instead of /api/health. Railway's healthcheck (see
// railway.json → deploy.healthcheckPath) hits /api/health specifically, so
// this route must opt out of versioning or the container never reports
// healthy — this was the actual cause of the "never became healthy" deploy
// failure (the build itself was fine).
@ApiTags("health")
@Controller({ path: "health", version: VERSION_NEUTRAL })
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
