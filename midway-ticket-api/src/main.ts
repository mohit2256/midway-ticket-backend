import { NestFactory } from "@nestjs/core";
import { ValidationPipe, VersioningType } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import helmet from "helmet";
import * as compression from "compression";
import { AppModule } from "./app.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { TransformInterceptor } from "./common/interceptors/transform.interceptor";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const config = app.get(ConfigService);
  const port   = config.get<number>("PORT", 3001);
  const prefix = config.get<string>("API_PREFIX", "api");

  app.use(helmet({ crossOriginEmbedderPolicy: false }));
  app.use(compression());

  // CORS — a misconfigured/missing FRONTEND_URL here silently breaks EVERY
  // API call from the deployed frontend (fetch fails, promises reject, and
  // any caller without a .catch() just hangs — this is what caused fairs
  // to spin forever and login to fail with no clear reason). Belt-and-braces:
  // - trim the env var (a stray trailing space/slash breaks exact-match CORS)
  // - always allow the known production Vercel domain explicitly, so this
  //   doesn't depend entirely on Railway's env var being set correctly
  // - allow any *.vercel.app preview deployment too, since Vercel generates
  //   a new preview URL per branch/PR
  const configuredFrontendUrl = config.get<string>("FRONTEND_URL", "").trim().replace(/\/$/, "");
  const knownOrigins = [
    configuredFrontendUrl,
    "https://midway-ticket.vercel.app",
    "http://localhost:3000",
  ].filter(Boolean);

  app.enableCors({
    origin: (origin, callback) => {
      // No origin header = server-to-server / curl / health checks — allow.
      if (!origin) return callback(null, true);
      const isKnown   = knownOrigins.includes(origin);
      const isVercel  = /^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin);
      callback(null, isKnown || isVercel);
    },
    credentials: true,
    methods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS"],
    allowedHeaders: ["Content-Type","Authorization"],
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
