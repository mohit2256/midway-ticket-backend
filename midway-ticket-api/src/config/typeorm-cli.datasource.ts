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

  entities: [
    path.join(__dirname, "..", "modules", "**", "*.{ts,js}"),
  ],

  migrations: [
    path.join(__dirname, "..", "migrations", "*.{ts,js}"),
  ],
});
