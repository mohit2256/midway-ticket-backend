// ═══════════════════════════════════════════════════════════════════════════════
// PARTITION MAINTENANCE — keeps `tickets` monthly partitions ahead of demand.
//
// The initial migration creates a rolling partition window. This service extends
// that window automatically so future event dates always have a dedicated
// monthly partition.
//
// Uses plain PostgreSQL SQL instead of pg_partman so it works with managed
// PostgreSQL providers such as Railway.
//
// The job is registered through BullMQ and also runs once on application boot.
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
   * Register the monthly maintenance job and run maintenance once immediately
   * when the application starts.
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
   * Creates the monthly partition 24 months ahead.
   *
   * IMPORTANT:
   * Do not pass PostgreSQL parameters ($1, $2...) inside a DO $$ block here.
   * PostgreSQL does not bind TypeORM parameters in this context the way a
   * normal parameterized query does. The numeric constant is controlled by
   * application code and inserted into the SQL after validation.
   */
  async extendPartitions(): Promise<void> {
    this.logger.log("Running tickets partition maintenance...");

    const monthsAhead = MONTHS_AHEAD_TO_MAINTAIN;

    // Defensive validation because this value becomes part of the SQL text.
    if (!Number.isInteger(monthsAhead) || monthsAhead < 0 || monthsAhead > 120) {
      throw new Error("Invalid MONTHS_AHEAD_TO_MAINTAIN value");
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

        part_name := 'tickets_' || to_char(target_month, 'YYYY_MM');

        SELECT EXISTS (
          SELECT 1
          FROM pg_class
          WHERE relname = part_name
        )
        INTO exists_check;

        IF NOT exists_check THEN
          EXECUTE format(
            'CREATE TABLE %I PARTITION OF tickets FOR VALUES FROM (%L) TO (%L)',
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
