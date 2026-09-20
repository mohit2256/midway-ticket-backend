import { MigrationInterface, QueryRunner } from "typeorm";

// ═══════════════════════════════════════════════════════════════════════════════
// PartitionTicketsByEventDate
//
// Converts `tickets` into a PostgreSQL declaratively-partitioned table,
// RANGE-partitioned by "eventDate" (monthly partitions).
//
// WHY eventDate, and why RANGE not LIST:
//   Every hot query in this app (a customer's tickets, a scanner validating
//   a ticket "for today", an operator's sales for a date range) is naturally
//   scoped to a date window. RANGE-by-month means Postgres can prune entire
//   partitions for date-scoped queries instead of scanning the whole table,
//   and old months become cheap to archive/drop later. LIST-by-fairId was
//   considered and rejected: fair count grows unboundedly and unpredictably
//   (every new event = a new partition to pre-create), whereas months are
//   finite and easy to pre-provision on a schedule.

//
// IMPORTANT TRADE-OFFS — read before running this against a real database:
//
//   1. Postgres requires a partitioned table's PRIMARY KEY / UNIQUE
//      constraints to include the partition key. So:
//        - PK becomes (id, "eventDate") instead of just (id).
//        - qrToken/displayId uniqueness becomes UNIQUE(col, "eventDate")
//          instead of a true global unique constraint. In practice this is
//          safe because both are generated as random/opaque values
//          (uuidv4 for qrToken; timestamp-based for displayId) — a collision
//          across two different eventDates is astronomically unlikely — but
//          it is no longer a DB-enforced global guarantee. If that matters
//          for your compliance requirements, add a second, tiny, UNPARTITIONED
//          lookup table (token -> ticket id) purely for uniqueness enforcement.
//
//   2. Foreign keys FROM other tables TO tickets.id alone can no longer be
//      enforced at the DB level (a FK target on a partitioned table must
//      reference the full partition key too). This migration therefore DROPS
//      the FK from scan_logs.ticketId -> tickets.id and leaves ticketId as a
//      plain indexed (not FK-constrained) column. Referential integrity for
//      that link becomes an application-level guarantee (TicketsService
//      always writes a real ticket id before logging a scan). This is the
//      standard, accepted trade-off for partitioning high-volume "fact"
//      tables and is what most partitioned ticketing/event systems do.
//
//   3. Partition maintenance: this migration pre-creates partitions for a
//      rolling window (6 months back .. 24 months forward) plus one DEFAULT
//      partition to catch anything outside that window so inserts never fail.
//      In production, schedule a monthly job (or use the `pg_partman`
//      extension) to create new far-future partitions before the DEFAULT
//      partition would otherwise absorb them — a DEFAULT partition can't be
//      split automatically and grows unbounded if forgotten.
// ═══════════════════════════════════════════════════════════════════════════════

export class PartitionTicketsByEventDate1735300000000 implements MigrationInterface {
  name = "PartitionTicketsByEventDate1735300000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 0a. Idempotency guard ────────────────────────────────────────────────
    // This migration is a rename → create → copy-data → drop sequence, not a
    // simple set of independently-guardable DDL statements — if a previous
    // run got killed partway through (e.g. by a platform healthcheck timeout,
    // which is exactly what happened once in this project's history), retrying
    // from the top could collide with whatever state it left behind (a
    // half-renamed table, partially-copied data, etc). Rather than trying to
    // resume from an unknown partial state, detect whether `tickets` is
    // *already* the partitioned table (relkind = 'p' — the same check
    // PartitionMaintenanceService uses elsewhere) and, if so, treat this
    // migration as already complete and exit early.
    const alreadyPartitioned = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'tickets' AND n.nspname = 'public' AND c.relkind = 'p'
      ) AS "exists"
    `);
    if (alreadyPartitioned?.[0]?.exists === true) {
      return;
    }

    // Self-heal a partial prior run: if a previous attempt got killed right
    // after the rename below but before the partitioned table was created,
    // `tickets_legacy` would exist with no `tickets` table at all — which
    // would break both this migration's retry and the running app. Restore
    // it before proceeding.
    const orphanedLegacy = await queryRunner.query(`
      SELECT
        EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'tickets_legacy' AND schemaname = 'public') AS "legacyExists",
        EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'tickets'        AND schemaname = 'public') AS "ticketsExists"
    `);
    if (orphanedLegacy?.[0]?.legacyExists === true && orphanedLegacy?.[0]?.ticketsExists === false) {
      await queryRunner.query(`ALTER TABLE tickets_legacy RENAME TO tickets`);
    }

    // ── 0b. Drop the FK that can't survive partitioning (see trade-off #2) ──
    await queryRunner.query(`
      DO $$
      DECLARE
        fk_name text;
      BEGIN
        SELECT tc.constraint_name INTO fk_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
        WHERE tc.table_name = 'scan_logs'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND kcu.column_name = 'ticketId';

        IF fk_name IS NOT NULL THEN
          EXECUTE format('ALTER TABLE scan_logs DROP CONSTRAINT %I', fk_name);
        END IF;
      END $$;
    `);

    // ── 1. Move the existing table out of the way ───────────────────────────
    await queryRunner.query(`ALTER TABLE tickets RENAME TO tickets_legacy`);

    // ── 2. Create the new partitioned table, same columns via LIKE ─────────
    // INCLUDING DEFAULTS keeps column types/defaults (including enum types)
    // without needing to hand-write every enum type name. Constraints and
    // indexes are recreated explicitly below instead of via INCLUDING ALL,
    // because a partitioned table can't directly inherit a PK that omits
    // the partition key.
    await queryRunner.query(`
      CREATE TABLE tickets (LIKE tickets_legacy INCLUDING DEFAULTS)
      PARTITION BY RANGE ("eventDate")
    `);

    await queryRunner.query(`
      ALTER TABLE tickets ADD PRIMARY KEY (id, "eventDate")
    `);

    // ── 3. Pre-create monthly partitions: 6 months back .. 24 months ahead ──
    await queryRunner.query(`
      DO $$
      DECLARE
        start_month date := date_trunc('month', now() - interval '6 months');
        end_month   date := date_trunc('month', now() + interval '24 months');
        cur         date := start_month;
        part_name   text;
      BEGIN
        WHILE cur < end_month LOOP
          part_name := 'tickets_' || to_char(cur, 'YYYY_MM');
          EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I PARTITION OF tickets FOR VALUES FROM (%L) TO (%L)',
            part_name, cur, cur + interval '1 month'
          );
          cur := cur + interval '1 month';
        END LOOP;
      END $$;
    `);

    // Catch-all so inserts outside the pre-created window never fail outright
    // — but see trade-off #3: this needs active maintenance, not neglect.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS tickets_default PARTITION OF tickets DEFAULT
    `);

    // ── 4. Copy data across ──────────────────────────────────────────────────
    await queryRunner.query(`INSERT INTO tickets SELECT * FROM tickets_legacy`);

    // ── 5. Recreate indexes (see trade-off #1 on qrToken/displayId) ─────────
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_tickets_qrToken_eventDate" ON tickets ("qrToken", "eventDate")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_tickets_displayId_eventDate" ON tickets ("displayId", "eventDate")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_tickets_fairId" ON tickets ("fairId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_tickets_rideId" ON tickets ("rideId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_tickets_customerId" ON tickets ("customerId")`);

    // ── 6. Restore ticketId index on scan_logs (no FK — see trade-off #2) ──
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_scan_logs_ticketId" ON scan_logs ("ticketId")
    `);

    await queryRunner.query(`DROP TABLE tickets_legacy`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Best-effort revert: collapse partitions back into one plain table.
    await queryRunner.query(`ALTER TABLE tickets RENAME TO tickets_partitioned`);

    await queryRunner.query(`
      CREATE TABLE tickets (LIKE tickets_partitioned INCLUDING DEFAULTS)
    `);
    await queryRunner.query(`ALTER TABLE tickets ADD PRIMARY KEY (id)`);
    await queryRunner.query(`INSERT INTO tickets SELECT * FROM tickets_partitioned`);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_tickets_qrToken" ON tickets ("qrToken")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_tickets_displayId" ON tickets ("displayId")`);

    await queryRunner.query(`DROP TABLE tickets_partitioned CASCADE`);

    // Note: this does NOT re-add the scan_logs -> tickets FK. If you need it
    // back, add it manually once you've confirmed no orphaned scan_logs rows
    // exist: ALTER TABLE scan_logs ADD CONSTRAINT ... FOREIGN KEY ("ticketId") REFERENCES tickets(id).
  }
}
