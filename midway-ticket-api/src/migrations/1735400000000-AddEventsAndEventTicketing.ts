import { MigrationInterface, QueryRunner } from "typeorm";

// ═══════════════════════════════════════════════════════════════════════════════
// AddEventsAndEventTicketing
//
// Adds the standalone "Events" feature (operator-hosted events that are NOT
// a Fair broken into Rides — e.g. a college auditorium show). This was
// previously shipped as an entity/code change ONLY, with no migration to go
// with it. If this deployment runs with DB_SYNC=false (the recommended,
// safe setting — see earlier audit notes on why DB_SYNC should stay off in
// production), the actual database never got the new "events" table or the
// new "eventId" columns the code expects. Any query that loads a full
// TicketEntity / StaffEntity / PaymentEntity row (a plain .find()/.getMany()
// with no explicit column list) then fails with a raw
// "column ... does not exist" Postgres error — which is exactly what was
// surfacing as "Couldn't load dashboard: Something went wrong on our end."
// This migration is what was missing.
//
// Every statement here is written defensively (IF NOT EXISTS / exception-
// swallowing DO blocks), matching the existing migrations in this repo —
// safe to run even if DB_SYNC was temporarily on and already created some of
// this by itself.
//
// NOTE on the partitioned "tickets" table (see PartitionTicketsByEventDate):
// adding a plain column to a partitioned parent table propagates to all of
// its partitions automatically, and a FK FROM tickets OUT to a normal
// (non-partitioned) table like "events" is fully supported — the
// partitioning trade-off noted in that migration only applies to being a FK
// TARGET (other tables referencing tickets.id), which this migration doesn't
// touch.
// ═══════════════════════════════════════════════════════════════════════════════

export class AddEventsAndEventTicketing1735400000000 implements MigrationInterface {
  name = "AddEventsAndEventTicketing1735400000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ────────────────────────────────────────────────────────────────────────
    // ENUM TYPE
    // ────────────────────────────────────────────────────────────────────────

    await queryRunner.query(`
      DO $$
      BEGIN
        CREATE TYPE "event_status_enum" AS ENUM (
          'DRAFT',
          'ACTIVE',
          'ENDED'
        );
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);

    // ────────────────────────────────────────────────────────────────────────
    // EVENTS TABLE
    // ────────────────────────────────────────────────────────────────────────

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying NOT NULL,
        "description" text,
        "venue" character varying NOT NULL,
        "city" character varying NOT NULL,
        "eventDate" date NOT NULL,
        "coverImageUrl" character varying,
        "coverGradient" character varying,
        "emoji" character varying,
        "capacity" integer NOT NULL DEFAULT 100,
        "pricePerTicket" numeric(10,2) NOT NULL DEFAULT 0,
        "requiresPayment" boolean NOT NULL DEFAULT false,
        "status" "event_status_enum" NOT NULL DEFAULT 'DRAFT',
        "operatorId" uuid,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),

        CONSTRAINT "PK_events_id"
          PRIMARY KEY ("id"),

        CONSTRAINT "FK_events_operator"
          FOREIGN KEY ("operatorId")
          REFERENCES "operators"("id")
          ON DELETE NO ACTION
          ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_events_operatorId"
      ON "events" ("operatorId")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_events_status"
      ON "events" ("status")
    `);

    // ────────────────────────────────────────────────────────────────────────
    // TICKETS — add nullable eventId (rideId/fairId were already nullable
    // columns from day one, so no ALTER needed for those)
    // ────────────────────────────────────────────────────────────────────────

    await queryRunner.query(`
      ALTER TABLE "tickets"
      ADD COLUMN IF NOT EXISTS "eventId" uuid
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        ALTER TABLE "tickets"
        ADD CONSTRAINT "FK_tickets_event"
          FOREIGN KEY ("eventId")
          REFERENCES "events"("id")
          ON DELETE NO ACTION
          ON UPDATE NO ACTION;
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_tickets_eventId"
      ON "tickets" ("eventId")
    `);

    // ────────────────────────────────────────────────────────────────────────
    // PAYMENTS — add nullable eventId (rideId was already nullable)
    // ────────────────────────────────────────────────────────────────────────

    await queryRunner.query(`
      ALTER TABLE "payments"
      ADD COLUMN IF NOT EXISTS "eventId" uuid
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        ALTER TABLE "payments"
        ADD CONSTRAINT "FK_payments_event"
          FOREIGN KEY ("eventId")
          REFERENCES "events"("id")
          ON DELETE NO ACTION
          ON UPDATE NO ACTION;
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_payments_eventId"
      ON "payments" ("eventId")
    `);

    // ────────────────────────────────────────────────────────────────────────
    // STAFF — add nullable assignedEventId (fairId/assignedRideId were
    // already nullable columns from day one, so no ALTER needed for those)
    // ────────────────────────────────────────────────────────────────────────

    await queryRunner.query(`
      ALTER TABLE "staff"
      ADD COLUMN IF NOT EXISTS "assignedEventId" uuid
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        ALTER TABLE "staff"
        ADD CONSTRAINT "FK_staff_assignedEvent"
          FOREIGN KEY ("assignedEventId")
          REFERENCES "events"("id")
          ON DELETE NO ACTION
          ON UPDATE NO ACTION;
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_staff_assignedEventId"
      ON "staff" ("assignedEventId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "staff" DROP CONSTRAINT IF EXISTS "FK_staff_assignedEvent"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_staff_assignedEventId"`);
    await queryRunner.query(`ALTER TABLE "staff" DROP COLUMN IF EXISTS "assignedEventId"`);

    await queryRunner.query(`ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "FK_payments_event"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_payments_eventId"`);
    await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN IF EXISTS "eventId"`);

    await queryRunner.query(`ALTER TABLE "tickets" DROP CONSTRAINT IF EXISTS "FK_tickets_event"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_tickets_eventId"`);
    await queryRunner.query(`ALTER TABLE "tickets" DROP COLUMN IF EXISTS "eventId"`);

    await queryRunner.query(`DROP TABLE IF EXISTS "events"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "event_status_enum"`);
  }
}
