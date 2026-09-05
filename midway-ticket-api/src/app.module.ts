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
        // otherwise race to ALTER the same tables. Schema changes normally go
        // through src/migrations (see typeorm-cli.datasource.ts) and are run
        // once — in CI/CD, before new instances start — not on every boot.
        //
        // TEMPORARY BOOTSTRAP ESCAPE HATCH: if migrations have never been run
        // against this database, the tables (fairs, tickets, etc.) simply
        // don't exist yet — every query 500s, which is exactly what was
        // happening here. Setting DB_SYNC=true as a Railway env var makes
        // TypeORM create every table from the current entities on next boot.
        // Safe to do once on an empty database. Once confirmed working,
        // REMOVE the DB_SYNC var (or set it to "false") so this goes back to
        // the safe, migration-only path — leaving it "true" long-term is what
        // the comment above warns against (multi-replica races).
        synchronize:      cfg.get("DB_SYNC") === "true",
        logging:          cfg.get("NODE_ENV") === "development",
      }),
    }),
    CacheModule.registerAsync({
      isGlobal: true,
      inject: [ConfigService],
      useFactory: async (cfg: ConfigService) => {
        const host     = cfg.get("REDIS_HOST", "localhost");
        const port     = cfg.get<number>("REDIS_PORT", 6379);
        const password = cfg.get("REDIS_PASSWORD");

        // FIX: cache-manager-redis-yet's redisStore() does `await client.connect()`
        // with no bounded timeout. If Redis is unreachable for any reason, that
        // await never resolves or rejects — it just hangs. Since this factory
        // itself is awaited during NestFactory.create(), an unreachable Redis
        // silently blocked the ENTIRE app from ever starting, with zero log
        // output and zero errors (exactly what production showed: 3+ minutes,
        // 8 healthcheck attempts, nothing in the logs after migrations). A
        // caching layer being briefly unavailable should degrade gracefully,
        // not take down ticket booking / fairs listing / login with it.
        try {
          const { redisStore } = await import("cache-manager-redis-yet");
          const store = await Promise.race([
            redisStore({
              socket: { host, port, connectTimeout: 5000, reconnectStrategy: false },
              password,
              ttl: 60_000,
            }),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("Redis connect timed out after 5s")), 5000),
            ),
          ]);
          console.log(`✅ Connected to Redis cache store at ${host}:${port}`);
          return { store };
        } catch (err) {
          console.error(
            `⚠️  Redis cache unavailable at ${host}:${port} (${(err as Error).message}) — ` +
            `falling back to in-memory cache. The app will still start; caching just ` +
            `won't be shared across instances until Redis is reachable again.`,
          );
          return {}; // cache-manager's built-in in-memory store
        }
      },
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        connection: {
          host:               cfg.get("REDIS_HOST", "localhost"),
          port:               cfg.get<number>("REDIS_PORT", 6379),
          password:           cfg.get("REDIS_PASSWORD"),
          connectTimeout:     5000,
          // FIX: bounds every individual Redis command issued through any
          // queue/worker sharing this connection (not just the initial TCP
          // connect). Without this, a command issued before the connection
          // is fully established — e.g. PartitionMaintenanceService's
          // queue.add() in onModuleInit() — sits in ioredis's internal
          // offline queue with no deadline, which is exactly what silently
          // hung the whole app at boot with zero log output.
          commandTimeout:       5000,
          maxRetriesPerRequest: null, // required by BullMQ; queue jobs simply wait/retry rather than the client giving up mid-command
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
