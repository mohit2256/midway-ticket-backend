import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ThrottlerModule } from "@nestjs/throttler";
import { CacheModule } from "@nestjs/cache-manager";
import { BullModule } from "@nestjs/bullmq";
import { AuthModule }     from "./modules/auth/auth.module";
import { UsersModule }    from "./modules/users/users.module";
import { FairsModule }    from "./modules/fairs/fairs.module";
import { RidesModule }    from "./modules/rides/rides.module";
import { TicketsModule }  from "./modules/tickets/tickets.module";
import { BookingsModule } from "./modules/bookings/bookings.module";
import { PaymentsModule } from "./modules/payments/payments.module";
import { StaffModule }    from "./modules/staff/staff.module";
import { AnalyticsModule }from "./modules/analytics/analytics.module";
import { HealthModule }   from "./modules/health/health.module";
import { RealtimeModule } from "./modules/realtime/realtime.module";
import { NotificationsModule } from "./modules/notifications/notifications.module";
import { PartitionMaintenanceModule } from "./modules/partition-maintenance/partition-maintenance.module";
import { appConfig, databaseConfig } from "./config/app.config";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ".env",
      load: [appConfig, databaseConfig],
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        type:             "postgres",
        host:             cfg.get("POSTGRES_HOST", "localhost"),
        port:             cfg.get<number>("POSTGRES_PORT", 5432),
        database:         cfg.get("POSTGRES_DB", "midwayticket"),
        username:         cfg.get("POSTGRES_USER", "midway"),
        password:         cfg.get("POSTGRES_PASSWORD"),
        ssl: cfg.get("POSTGRES_SSL") === "true" ? { rejectUnauthorized: false } : false,
        autoLoadEntities: true,
        // Horizontal scaling requires this to be false everywhere, not just
        // in prod: with 2+ replicas, every instance boots at once and would
        // otherwise race to ALTER the same tables. Schema changes now go
        // through src/migrations (see typeorm-cli.datasource.ts) and are run
        // once — in CI/CD, before new instances start — not on every boot.
        synchronize:      false,
        logging:          cfg.get("NODE_ENV") === "development",
      }),
    }),
    CacheModule.registerAsync({
      isGlobal: true,
      inject: [ConfigService],
      useFactory: async (cfg: ConfigService) => ({
        store:    (await import("cache-manager-redis-yet")).redisStore,
        socket:   { host: cfg.get("REDIS_HOST","localhost"), port: cfg.get<number>("REDIS_PORT",6379) },
        password: cfg.get("REDIS_PASSWORD"),
        ttl:      60_000,
      }),
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        connection: {
          host:     cfg.get("REDIS_HOST","localhost"),
          port:     cfg.get<number>("REDIS_PORT",6379),
          password: cfg.get("REDIS_PASSWORD"),
        },
      }),
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        throttlers: [{ ttl: cfg.get<number>("THROTTLE_TTL",60000), limit: cfg.get<number>("THROTTLE_LIMIT",100) }],
      }),
    }),
    AuthModule, UsersModule, FairsModule, RidesModule, TicketsModule,
    BookingsModule, PaymentsModule, StaffModule, AnalyticsModule, HealthModule,
    RealtimeModule, NotificationsModule, PartitionMaintenanceModule,
  ],
})
export class AppModule {}
