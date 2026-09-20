import { NestFactory } from "@nestjs/core";
import { ValidationPipe, VersioningType } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import helmet from "helmet";
import * as compression from "compression";
import { AppModule } from "./app.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { TransformInterceptor } from "./common/interceptors/transform.interceptor";
import typeormCliDataSource from "./config/typeorm-cli.datasource";

// FIX: production deploys were hanging silently after migrations completed,
// with zero further log output for 3+ minutes until the healthcheck gave up.
// That silence made it impossible to tell whether the hang was in Nest's
// module graph resolution, a specific module's connection setup, or
// something else entirely. These handlers plus the explicit checkpoints
// below exist purely so the NEXT deploy's logs point at the exact line,
// instead of another round of guessing.
process.on("unhandledRejection", (reason) => {
  console.error("🔥 UNHANDLED REJECTION during boot:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("🔥 UNCAUGHT EXCEPTION during boot:", err);
}); 

/**
 * Run pending TypeORM migrations before the Nest app even boots.
 *
 * FIX: this is the third and final attempt at getting migrations to run in
 * production. Neither a Railway "startCommand" override (dashboard/API)
 * nor a Dockerfile CMD chain (`migration:run && node dist/main`) ever
 * actually executed — live deploy logs confirmed every real deploy still
 * launched via a plain `node dist/main`, with zero migration output,
 * across three separate fix attempts. Whatever Railway/Nixpacks does under
 * the hood for this project, it always ends up running the compiled
 * `dist/main.js` directly.
 *
 * So: stop trying to inject a shell step *before* that process starts, and
 * instead make migrations part of what that process does the moment it
 * starts. This runs on a short-lived standalone DataSource, fully
 * independent of Nest's DI/module lifecycle, and completes *before*
 * NestFactory.create() is even called — so lifecycle hooks like
 * PartitionMaintenanceService's onApplicationBootstrap (which checks for
 * the "tickets" table) never again race against a not-yet-migrated schema.
 *
 * Safe to run on every boot: TypeORM tracks applied migrations in its own
 * `migrations` table and no-ops anything already run.
 */
async function runMigrations() {
  console.log("⏳ [BOOT 1/4] Checking for pending database migrations...");
  await typeormCliDataSource.initialize();
  try {
    const executed = await typeormCliDataSource.runMigrations();
    if (executed.length > 0) {
      console.log(`✅ [BOOT 1/4] Ran ${executed.length} migration(s): ${executed.map((m) => m.name).join(", ")}`);
    } else {
      console.log("✅ [BOOT 1/4] Database schema already up to date.");
    }
  } finally {
    // FIX: DataSource.destroy() closing out the underlying pg pool has, in
    // production, hung indefinitely on this Postgres instance — every failed
    // deploy's logs stopped dead right after the migration check with zero
    // further output, even across a full 3-minute healthcheck window, which
    // only makes sense if something here never resolved and bootstrap()
    // never reached NestFactory.create() at all. A boot-time migration check
    // is not worth risking the entire app's startup over a slow/stuck pool
    // teardown, so this can never block longer than 5s — if destroy() hasn't
    // finished by then, log it and move on; the process exiting later will
    // release the connection anyway.
    await Promise.race([
      typeormCliDataSource.destroy(),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]).catch((err) => console.error("⚠️  Migration DataSource teardown error (continuing anyway):", err));
    console.log("✅ [BOOT 1/4] Migration check complete.");
  }
}

async function bootstrap() {
  try {
    await runMigrations();
  } catch (err) {
    // Fail fast rather than serve traffic against a broken/partial schema —
    // Railway's restartPolicy (ON_FAILURE) will retry the container.
    console.error("❌ [BOOT 1/4] Migration run failed — refusing to start:", err);
    process.exit(1);
  }

  console.log("🏗️  [BOOT 2/4] Calling NestFactory.create() — this resolves every module's providers, including Cache/Bull/TypeOrm connections...");
  const app = await NestFactory.create(AppModule, { rawBody: true });
  console.log("✅ [BOOT 2/4] NestFactory.create() returned — Nest app instance created.");

  const config = app.get(ConfigService);
  const port   = config.get<number>("PORT", 3001);
  const prefix = config.get<string>("API_PREFIX", "api");

  app.use(helmet({ crossOriginEmbedderPolicy: false }));
  app.use(compression());

  const configuredFrontendUrl = config.get<string>("FRONTEND_URL", "").trim().replace(/\/$/, "");
  const knownOrigins = [
    configuredFrontendUrl,
    "https://midway-ticket.vercel.app",
    "http://localhost:3000",
  ].filter(Boolean);

  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      const isKnown  = knownOrigins.includes(origin);
      const isVercel = /^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin);
      callback(null, isKnown || isVercel);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    // idempotency-key is used by POST /bookings to prevent duplicate tickets
    // on double-click or network retry. Must be listed here or the browser's
    // CORS preflight rejects it before our controller even sees the request.
    allowedHeaders: ["Content-Type", "Authorization", "idempotency-key"],
    exposedHeaders: ["idempotency-key"],
  });

  app.setGlobalPrefix(prefix);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });

  app.useGlobalPipes(new ValidationPipe({
    whitelist: true, forbidNonWhitelisted: true,
    transform: true, transformOptions: { enableImplicitConversion: true },
  }));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new TransformInterceptor());
  console.log("✅ [BOOT 3/4] Middleware, CORS, pipes, filters configured.");

  if (config.get("NODE_ENV") !== "production") {
    const doc = new DocumentBuilder()
      .setTitle("MidwayTicket API")
      .setVersion("1.0")
      .addBearerAuth()
      .build();
    SwaggerModule.setup(`${prefix}/docs`, app, SwaggerModule.createDocument(app, doc));
    console.log(`📚 Swagger: http://localhost:${port}/${prefix}/docs`);
  }

  console.log(`🏗️  [BOOT 4/4] Calling app.listen(${port})...`);
  await app.listen(port, "0.0.0.0");
  console.log(`🚀 [BOOT 4/4] MidwayTicket API is LISTENING → http://localhost:${port}/${prefix}/v1`);
}
bootstrap();
