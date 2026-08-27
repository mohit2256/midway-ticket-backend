// ─────────────────────────────────────────────────────────────────────────────
// TypeORM CLI DataSource — used ONLY by `migration:run` / `migration:generate`.
//
// WHY THIS FILE EXISTS (horizontal-scaling prep):
// `synchronize: true` (used in app.module.ts for dev) auto-alters the DB
// schema on every boot. That is fine for 1 instance, but the moment you run
// 2+ API replicas behind a load balancer, every instance boots at once and
// they will race to ALTER the same tables — causing deploy-time crashes or
// silent data issues. The fix is: migrations are files, checked into git,
// run ONCE (in CI/CD, before new instances start), and `synchronize` is
// ALWAYS false in production. This file is what `migration:run` points at.
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import { DataSource } from "typeorm";
import * as path from "path";

export default new DataSource({
  type:     "postgres",
  host:     process.env.POSTGRES_HOST ?? "localhost",
  port:     parseInt(process.env.POSTGRES_PORT ?? "5432", 10),
  database: process.env.POSTGRES_DB ?? "midwayticket",
  username: process.env.POSTGRES_USER ?? "midway",
  password: process.env.POSTGRES_PASSWORD,
  ssl:      process.env.POSTGRES_SSL === "true" ? { rejectUnauthorized: false } : false,

  // Never true here — this connection's only job is running migration files.
  synchronize: false,

  entities:   [path.join(__dirname, "..", "modules", "**", "*.{ts,js}")],
  migrations: [path.join(__dirname, "..", "migrations", "*.{ts,js}")],
});
