import { registerAs } from "@nestjs/config";

export const appConfig = registerAs("app", () => ({
  port:        parseInt(process.env.PORT ?? "3001", 10),
  env:         process.env.NODE_ENV ?? "development",
  apiPrefix:   process.env.API_PREFIX ?? "api",
  frontendUrl: process.env.FRONTEND_URL ?? "http://localhost:3000",

  jwt: {
    secret:         process.env.JWT_SECRET ?? "change-me",
    expiresIn:      process.env.JWT_EXPIRES_IN ?? "7d",
    refreshSecret:  process.env.JWT_REFRESH_SECRET ?? "change-me-refresh",
    refreshExpires: process.env.JWT_REFRESH_EXPIRES_IN ?? "30d",
  },

  // ── Feature flag: payments ────────────────────────────────────────────────
  // OFF for the launch/validation phase — booking issues a ticket directly
  // (no charge), for exactly the "book + get QR by email" MVP being shipped
  // first. Flip PAYMENTS_ENABLED=true (+ set the razorpay keys below) once
  // the paid-booking feature is ready; BookingsService branches on this flag,
  // no code path needs to be rewritten to turn it on.
  paymentsEnabled: process.env.PAYMENTS_ENABLED === "true",

  razorpay: {
    keyId:         process.env.RAZORPAY_KEY_ID ?? "",
    keySecret:     process.env.RAZORPAY_KEY_SECRET ?? "",
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET ?? "",
  },

  throttle: {
    ttl:      parseInt(process.env.THROTTLE_TTL ?? "60000", 10),
    limit:    parseInt(process.env.THROTTLE_LIMIT ?? "100", 10),
    scanTtl:  parseInt(process.env.SCAN_THROTTLE_TTL ?? "5000", 10),
    scanLimit:parseInt(process.env.SCAN_THROTTLE_LIMIT ?? "10", 10),
  },

  smtp: {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT ?? "587", 10),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.EMAIL_FROM ?? "tickets@midwayticket.in",
  },
}));

export const databaseConfig = registerAs("database", () => ({
  host:     process.env.POSTGRES_HOST ?? "localhost",
  port:     parseInt(process.env.POSTGRES_PORT ?? "5432", 10),
  database: process.env.POSTGRES_DB ?? "midwayticket",
  username: process.env.POSTGRES_USER ?? "midway",
  password: process.env.POSTGRES_PASSWORD,
  ssl:      process.env.POSTGRES_SSL === "true",
}));
