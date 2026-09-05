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
  console.log("⏳ Checking for pending database migrations...");
  await typeormCliDataSource.initialize();
  try {
    const executed = await typeormCliDataSource.runMigrations();
    if (executed.length > 0) {
      console.log(`✅ Ran ${executed.length} migration(s): ${executed.map((m) => m.name).join(", ")}`);
    } else {
      console.log("✅ Database schema already up to date.");
    }
  } finally {
    await typeormCliDataSource.destroy();
  }
}

async function bootstrap() {
  try {
    await runMigrations();
  } catch (err) {
    // Fail fast rather than serve traffic against a broken/partial schema —
    // Railway's restartPolicy (ON_FAILURE) will retry the container.
    console.error("❌ Migration run failed — refusing to start:", err);
    process.exit(1);
  }

  const app = await NestFactory.create(AppModule, { rawBody: true });
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

  if (config.get("NODE_ENV") !== "production") {
    const doc = new DocumentBuilder()
      .setTitle("MidwayTicket API")
      .setVersion("1.0")
      .addBearerAuth()
      .build();
    SwaggerModule.setup(`${prefix}/docs`, app, SwaggerModule.createDocument(app, doc));
    console.log(`📚 Swagger: http://localhost:${port}/${prefix}/docs`);
  }

  await app.listen(port, "0.0.0.0");
  console.log(`🚀 MidwayTicket API → http://localhost:${port}/${prefix}/v1`);
}
bootstrap();
