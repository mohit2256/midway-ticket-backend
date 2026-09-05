// ─────────────────────────────────────────────────────────────────────────────
// TypeORM CLI DataSource
//
// Used by migration:run / migration:generate / migration:revert.
//
// Production migrations are executed against the compiled JavaScript files
// under dist/.
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import { DataSource } from "typeorm";
import * as path from "path";

export default new DataSource({
  type: "postgres",

  host: process.env.POSTGRES_HOST ?? "localhost",
  port: parseInt(process.env.POSTGRES_PORT ?? "5432", 10),

  database: process.env.POSTGRES_DB ?? "midwayticket",
  username: process.env.POSTGRES_USER ?? "midway",
  password: process.env.POSTGRES_PASSWORD,

  ssl:
    process.env.POSTGRES_SSL === "true"
      ? { rejectUnauthorized: false }
      : false,

  // Migrations are responsible for schema changes.
  synchronize: false,

  // FIX: with no `logging` set, TypeORM's migration runner echoed every
  // single SQL statement (each CREATE TYPE / CREATE TABLE / index) as its
  // own log line. On the very first real run — two migrations building the
  // full schema plus ticket partitions from scratch — that was enough lines
  // fast enough to trip Railway's per-deployment log rate limit mid-run,
  // which contributed to the container never reporting healthy in time.
  // Keep high-level migration progress (what ran, in what order) without
  // the per-query firehose.
  logging: ["error", "warn", "migration"],

  entities: [
    path.join(__dirname, "..", "modules", "**", "*.{ts,js}"),
  ],

  migrations: [
    path.join(__dirname, "..", "migrations", "*.{ts,js}"),
  ],
});
