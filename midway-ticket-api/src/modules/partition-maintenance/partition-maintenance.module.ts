// ═══════════════════════════════════════════════════════════════════════════════
// PARTITION MAINTENANCE
//
// Keeps `tickets` monthly partitions ahead of demand.
//
// The initial migration creates the base `tickets` table and its initial
// partition window. This service extends the window automatically.
//
// Uses plain PostgreSQL SQL instead of pg_partman so it works with managed
// PostgreSQL providers such as Railway.
//
// IMPORTANT:
// This service MUST NOT crash the entire API if the database schema has not
// been created yet. Migrations are responsible for creating the `tickets`
// table. Until that table exists, maintenance simply skips the current run.
// ═══════════════════════════════════════════════════════════════════════════════

import {
  Injectable,
  Logger,
  Module,
  OnModuleInit,
} from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import {
  InjectQueue,
  Processor,
  WorkerHost,
  BullModule,
} from "@nestjs/bullmq";
import { Queue, Job } from "bullmq";

const PARTITION_QUEUE = "partition-maintenance";
const MONTHS_AHEAD_TO_MAINTAIN = 24;

@Injectable()
export class PartitionMaintenanceService implements OnModuleInit {
  private readonly logger = new Logger(
    PartitionMaintenanceService.name,
  );

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @InjectQueue(PARTITION_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Register the monthly maintenance job.
   *
   * We also attempt one immediate maintenance run on boot, but the attempt
   * is intentionally safe: if migrations have not created `tickets` yet,
   * the API continues starting normally instead of crashing.
   */
  async onModuleInit(): Promise<void> {
    await this.queue.add(
      "extend-partitions",
      {},
      {
        jobId: "monthly-partition-extend",
        repeat: {
          pattern: "0 3 1 * *",
        },
      },
    );

    await this.extendPartitions();
  }

  /**
   * Check whether the tickets table exists before attempting any partition
   * operation.
   *
   * This protects application startup on a fresh database or during a
   * deployment where migrations have not completed yet.
   */
 private async ticketsTableExists(): Promise<boolean> {
  const result = await this.db.query(`
    SELECT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = 'tickets'
        AND n.nspname = 'public'
        AND c.relkind = 'p'
    ) AS "exists"
  `);
  return result[0]?.exists === true;
}

  /**
   * Creates the monthly partition 24 months ahead.
   *
   * PostgreSQL parameters ($1, $2...) are intentionally NOT used inside the
   * DO $$ block. The value is a validated application constant and is safely
   * inserted into the SQL text.
   */
  async extendPartitions(): Promise<void> {
    this.logger.log("Running tickets partition maintenance...");

    // ── Safety guard ────────────────────────────────────────────────────────
    const ticketsExists = await this.ticketsTableExists();

    if (!ticketsExists) {
      this.logger.warn(
        'Skipping partition maintenance because the "tickets" table does not exist yet. ' +
          "Run the database migrations first.",
      );

      return;
    }

    const monthsAhead = MONTHS_AHEAD_TO_MAINTAIN;

    // Defensive validation because this value becomes part of SQL text.
    if (
      !Number.isInteger(monthsAhead) ||
      monthsAhead < 0 ||
      monthsAhead > 120
    ) {
      throw new Error(
        "Invalid MONTHS_AHEAD_TO_MAINTAIN value",
      );
    }

    await this.db.query(`
      DO $$
      DECLARE
        target_month date;
        part_name text;
        exists_check boolean;
      BEGIN
        target_month := date_trunc(
          'month',
          now() + interval '${monthsAhead} months'
        )::date;

        part_name :=
          'tickets_' || to_char(target_month, 'YYYY_MM');

        SELECT EXISTS (
          SELECT 1
          FROM pg_class
          WHERE relname = part_name
        )
        INTO exists_check;

        IF NOT exists_check THEN
          EXECUTE format(
            'CREATE TABLE %I PARTITION OF "tickets" FOR VALUES FROM (%L) TO (%L)',
            part_name,
            target_month,
            target_month + interval '1 month'
          );

          RAISE NOTICE 'Created partition %', part_name;
        END IF;
      END $$;
    `);

    this.logger.log(
      `Partition maintenance complete (window: ${monthsAhead} months ahead).`,
    );
  }
}

@Processor(PARTITION_QUEUE)
export class PartitionMaintenanceProcessor extends WorkerHost {
  constructor(
    private readonly svc: PartitionMaintenanceService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    await this.svc.extendPartitions();
  }
}

@Module({
  imports: [
    BullModule.registerQueue({
      name: PARTITION_QUEUE,
    }),
  ],
  providers: [
    PartitionMaintenanceService,
    PartitionMaintenanceProcessor,
  ],
  exports: [
    PartitionMaintenanceService,
  ],
})
export class PartitionMaintenanceModule {}
