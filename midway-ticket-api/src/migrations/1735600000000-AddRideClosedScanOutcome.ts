import { MigrationInterface, QueryRunner } from "typeorm";

// ═══════════════════════════════════════════════════════════════════════════════
// AddRideClosedScanOutcome
//
// Part of the camera-based scanning feature: ScanLogEntity.outcome is a real
// Postgres enum column ("scan_outcome_enum"), so adding ScanOutcome.RIDE_CLOSED
// to the TypeScript enum in entities.ts needs a matching schema change here —
// otherwise the very first scan that hits this new code path (ride paused/
// maintenance, or fair/event ended) fails with a raw Postgres
// "invalid input value for enum" error instead of returning the intended
// RIDE_CLOSED result.
//
// `ALTER TYPE ... ADD VALUE` is safe to run inside a normal transaction on
// Postgres 12+ as long as the new value isn't used in the same transaction
// it's added in — which isn't the case here.
// ═══════════════════════════════════════════════════════════════════════════════

export class AddRideClosedScanOutcome1735600000000 implements MigrationInterface {
  name = "AddRideClosedScanOutcome1735600000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        ALTER TYPE "scan_outcome_enum" ADD VALUE IF NOT EXISTS 'RIDE_CLOSED';
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);
  }

  public async down(): Promise<void> {
    // Postgres has no direct "DROP VALUE FROM ENUM" — removing a value
    // safely requires rebuilding the type (rename old, create new without
    // the value, migrate the column, drop old). Not implemented here since
    // there's no destructive need to ever roll this back in practice: an
    // unused enum value sitting in the type is harmless.
  }
}
