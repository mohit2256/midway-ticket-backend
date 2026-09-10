import { MigrationInterface, QueryRunner } from "typeorm";

// ═══════════════════════════════════════════════════════════════════════════════
// AddEmailVerificationAndPasswordReset
//
// Adds email verification and self-service password reset support to
// UserEntity. Written defensively (IF NOT EXISTS everywhere) to match the
// existing migrations in this repo, and safe to run even if DB_SYNC was
// temporarily on and already created some of this.
// ═══════════════════════════════════════════════════════════════════════════════

export class AddEmailVerificationAndPasswordReset1735500000000 implements MigrationInterface {
  name = "AddEmailVerificationAndPasswordReset1735500000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "emailVerified" boolean NOT NULL DEFAULT false
    `);

    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "emailVerificationTokenHash" character varying
    `);

    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "emailVerificationExpiresAt" TIMESTAMPTZ
    `);

    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "passwordResetTokenHash" character varying
    `);

    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "passwordResetExpiresAt" TIMESTAMPTZ
    `);

    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "passwordChangedAt" TIMESTAMPTZ
    `);

    // Existing accounts weren't verified through this flow — mark them
    // verified retroactively so nobody who already signed up before this
    // migration gets locked out of anything that later checks this flag.
    // (Registration itself was never gated on this, so this is a courtesy,
    // not a correctness requirement.)
    await queryRunner.query(`
      UPDATE "users" SET "emailVerified" = true WHERE "createdAt" < now()
    `);

    // Lookups by token hash happen on every verify/reset request.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_users_emailVerificationTokenHash"
      ON "users" ("emailVerificationTokenHash")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_users_passwordResetTokenHash"
      ON "users" ("passwordResetTokenHash")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_users_passwordResetTokenHash"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_users_emailVerificationTokenHash"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "passwordChangedAt"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "passwordResetExpiresAt"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "passwordResetTokenHash"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "emailVerificationExpiresAt"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "emailVerificationTokenHash"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "emailVerified"`);
  }
}
