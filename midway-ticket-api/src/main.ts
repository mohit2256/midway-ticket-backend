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

  // CORS — allow frontend origin from env
  const frontendUrl = config.get<string>("FRONTEND_URL", "http://localhost:3000");
  app.enableCors({
    origin: [
      frontendUrl,
      "http://localhost:3000",
      // Add your Vercel production URL here after deploy:
      // "https://your-app.vercel.app",
    ],
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
