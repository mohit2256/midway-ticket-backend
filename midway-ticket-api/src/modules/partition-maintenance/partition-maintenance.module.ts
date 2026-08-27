// ═══════════════════════════════════════════════════════════════════════════════
// PARTITION MAINTENANCE — keeps `tickets` monthly partitions ahead of demand.
//
// WHY APP-LEVEL INSTEAD OF pg_partman:
// pg_partman is a Postgres *extension* — it must be installed by a superuser
// on the database server itself. Managed Postgres providers (Railway, most
// hosted Postgres) either don't allow installing arbitrary extensions or
// require a support ticket to enable one. This app could end up hosted on
// any of them, so partition maintenance is done here, in application code,
// using nothing but plain SQL any Postgres 12+ instance supports. This is
// the same approach pg_partman uses internally — a scheduled function call —
// just triggered by BullMQ's repeatable jobs instead of pg_cron.
//
// The migration (PartitionTicketsByEventDate) pre-creates a 6-months-back to
// 24-months-forward window plus a DEFAULT partition on deploy day. This job
// re-runs every 1st of the month and extends that window by one more month,
// so the DEFAULT partition (slow, unindexed-by-range, not meant for real
// traffic) never actually receives rows in normal operation.
// ═══════════════════════════════════════════════════════════════════════════════

import { Injectable, Logger, Module, OnModuleInit } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { InjectQueue, Processor, WorkerHost, BullModule } from "@nestjs/bullmq";
import { Queue, Job } from "bullmq";

const PARTITION_QUEUE = "partition-maintenance";
const MONTHS_AHEAD_TO_MAINTAIN = 24; // keep this many months pre-created from "now"

@Injectable()
export class PartitionMaintenanceService implements OnModuleInit {
  private readonly logger = new Logger(PartitionMaintenanceService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @InjectQueue(PARTITION_QUEUE) private readonly queue: Queue,
  ) {}

  /** Schedule the repeatable job once, on boot. BullMQ dedupes by jobId, so
   *  this is safe to run on every instance/replica startup. */
  async onModuleInit() {
    await this.queue.add(
      "extend-partitions",
      {},
      {
        jobId: "monthly-partition-extend", // stable id → no duplicate schedules
        repeat: { pattern: "0 3 1 * *" },   // 03:00 on the 1st of every month
      },
    );
    // Also run once immediately on boot so a freshly-deployed instance isn't
    // waiting up to a month for the first extension.
    await this.extendPartitions();
  }

  async extendPartitions(): Promise<void> {
    this.logger.log("Running tickets partition maintenance...");
    await this.db.query(
      `
      DO $$
      DECLARE
        target_month date := date_trunc('month', now() + ($1 || ' months')::interval);
        part_name    text := 'tickets_' || to_char(target_month, 'YYYY_MM');
        exists_check boolean;
      BEGIN
        SELECT EXISTS (
          SELECT 1 FROM pg_class WHERE relname = part_name
        ) INTO exists_check;

        IF NOT exists_check THEN
          EXECUTE format(
            'CREATE TABLE %I PARTITION OF tickets FOR VALUES FROM (%L) TO (%L)',
            part_name, target_month, target_month + interval '1 month'
          );
          RAISE NOTICE 'Created partition %', part_name;
        END IF;
      END $$;
      `,
      [MONTHS_AHEAD_TO_MAINTAIN],
    );
    this.logger.log(`Partition maintenance complete (window: ${MONTHS_AHEAD_TO_MAINTAIN} months ahead).`);
  }
}

@Processor(PARTITION_QUEUE)
export class PartitionMaintenanceProcessor extends WorkerHost {
  constructor(private readonly svc: PartitionMaintenanceService) {
    super();
  }

  async process(job: Job) {
    await this.svc.extendPartitions();
  }
}

@Module({
  imports: [BullModule.registerQueue({ name: PARTITION_QUEUE })],
  providers: [PartitionMaintenanceService, PartitionMaintenanceProcessor],
  exports: [PartitionMaintenanceService],
})
export class PartitionMaintenanceModule {}
