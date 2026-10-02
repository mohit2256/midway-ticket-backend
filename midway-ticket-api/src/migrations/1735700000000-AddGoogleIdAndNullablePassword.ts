import { MigrationInterface, QueryRunner } from "typeorm";

// ═══════════════════════════════════════════════════════════════════════════════
// AddGoogleIdAndNullablePassword
//
// Part of the guest-checkout + Google sign-in rework:
//   - passwordHash was NOT NULL from day one — guest-checkout accounts and
//     Google-only accounts never set a password, so it has to become
//     nullable or every guest/Google account creation fails at the DB level.
//   - googleId links a User row to a verified Google account (see
//     AuthService.findOrCreateGoogleUser). Unique so the same Google account
//     can never end up linked to two different User rows.
// ═══════════════════════════════════════════════════════════════════════════════

export class AddGoogleIdAndNullablePassword1735700000000 implements MigrationInterface {
  name = "AddGoogleIdAndNullablePassword1735700000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
      ALTER COLUMN "passwordHash" DROP NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "googleId" character varying
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        ALTER TABLE "users" ADD CONSTRAINT "UQ_users_googleId" UNIQUE ("googleId");
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "UQ_users_googleId"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "googleId"`);
    // Deliberately NOT restoring NOT NULL on passwordHash — by the time this
    // would ever be rolled back, real guest/Google accounts with NULL
    // passwords already exist, and restoring the constraint would fail
    // outright (or require destructively deleting those accounts first).
  }
}
