import { MigrationInterface, QueryRunner } from "typeorm";

export class InitialSchema1735290000000 implements MigrationInterface {
  name = "InitialSchema1735290000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // UUID generation
    await queryRunner.query(`
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp"
    `);

    // ────────────────────────────────────────────────────────────────────────
    // ENUM TYPES
    // ────────────────────────────────────────────────────────────────────────

    await queryRunner.query(`
      DO $$
      BEGIN
        CREATE TYPE "user_role_enum" AS ENUM (
          'CUSTOMER',
          'OPERATOR_OWNER',
          'OPERATOR_MANAGER',
          'SCANNER_STAFF'
        );
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        CREATE TYPE "subscription_plan_enum" AS ENUM (
          'TRIAL',
          'STARTER',
          'GROWTH',
          'ENTERPRISE'
        );
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        CREATE TYPE "fair_status_enum" AS ENUM (
          'DRAFT',
          'ACTIVE',
          'ENDED'
        );
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        CREATE TYPE "ride_category_enum" AS ENUM (
          'Thrill',
          'Family',
          'Kids',
          'Games'
        );
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        CREATE TYPE "ride_status_enum" AS ENUM (
          'Active',
          'Paused',
          'Maintenance'
        );
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        CREATE TYPE "ticket_status_enum" AS ENUM (
          'Valid',
          'Used',
          'Expired',
          'Cancelled'
        );
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        CREATE TYPE "payment_status_enum" AS ENUM (
          'Pending',
          'Paid',
          'Failed',
          'Refunded'
        );
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        CREATE TYPE "payment_method_enum" AS ENUM (
          'UPI',
          'Card',
          'NetBanking',
          'Wallet',
          'Free'
        );
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        CREATE TYPE "scan_outcome_enum" AS ENUM (
          'VALID',
          'WRONG_RIDE',
          'ALREADY_USED',
          'INVALID',
          'EXPIRED',
          'PAYMENT_FAIL'
        );
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        CREATE TYPE "notification_type_enum" AS ENUM (
          'TICKET_ISSUED',
          'TICKET_SCANNED',
          'RIDE_SOLD_OUT',
          'PAYMENT_FAILED'
        );
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        CREATE TYPE "notification_channel_enum" AS ENUM (
          'IN_APP',
          'EMAIL',
          'PUSH'
        );
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        CREATE TYPE "notification_status_enum" AS ENUM (
          'PENDING',
          'SENT',
          'FAILED'
        );
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        CREATE TYPE "operator_transaction_type_enum" AS ENUM (
          'PAYOUT',
          'ADJUSTMENT',
          'REFUND_DEBIT'
        );
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        CREATE TYPE "operator_transaction_status_enum" AS ENUM (
          'PENDING',
          'PROCESSING',
          'COMPLETED',
          'FAILED'
        );
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);

    // ────────────────────────────────────────────────────────────────────────
    // USERS
    // ────────────────────────────────────────────────────────────────────────

    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying NOT NULL,
        "email" character varying NOT NULL,
        "phone" character varying,
        "passwordHash" character varying NOT NULL,
        "role" "user_role_enum" NOT NULL DEFAULT 'CUSTOMER',
        "isActive" boolean NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),

        CONSTRAINT "PK_users_id"
          PRIMARY KEY ("id"),

        CONSTRAINT "UQ_users_email"
          UNIQUE ("email")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_users_email"
      ON "users" ("email")
    `);

    // ────────────────────────────────────────────────────────────────────────
    // OPERATORS
    // ────────────────────────────────────────────────────────────────────────

    await queryRunner.query(`
      CREATE TABLE "operators" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying NOT NULL,
        "plan" "subscription_plan_enum" NOT NULL DEFAULT 'TRIAL',
        "planExpiresAt" TIMESTAMP,
        "payoutAccountId" character varying,
        "isActive" boolean NOT NULL DEFAULT true,
        "ownerId" uuid,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),

        CONSTRAINT "PK_operators_id"
          PRIMARY KEY ("id"),

        CONSTRAINT "FK_operators_owner"
          FOREIGN KEY ("ownerId")
          REFERENCES "users"("id")
          ON DELETE NO ACTION
          ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_operators_ownerId"
      ON "operators" ("ownerId")
    `);

    // ────────────────────────────────────────────────────────────────────────
    // FAIRS
    // ────────────────────────────────────────────────────────────────────────

    await queryRunner.query(`
      CREATE TABLE "fairs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying NOT NULL,
        "location" character varying NOT NULL,
        "city" character varying NOT NULL,
        "startDate" date NOT NULL,
        "endDate" date NOT NULL,
        "description" text,
        "coverImageUrl" character varying,
        "coverGradient" character varying,
        "emoji" character varying,
        "status" "fair_status_enum" NOT NULL DEFAULT 'DRAFT',
        "operatorId" uuid,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),

        CONSTRAINT "PK_fairs_id"
          PRIMARY KEY ("id"),

        CONSTRAINT "FK_fairs_operator"
          FOREIGN KEY ("operatorId")
          REFERENCES "operators"("id")
          ON DELETE NO ACTION
          ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_fairs_operatorId"
      ON "fairs" ("operatorId")
    `);

    // ────────────────────────────────────────────────────────────────────────
    // RIDES
    // ────────────────────────────────────────────────────────────────────────

    await queryRunner.query(`
      CREATE TABLE "rides" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying NOT NULL,
        "description" text,
        "category" "ride_category_enum" NOT NULL,
        "emoji" character varying,
        "coverGradient" character varying,
        "pricePerPerson" numeric(10,2) NOT NULL,
        "durationMinutes" integer NOT NULL DEFAULT 5,
        "minAge" integer,
        "capacity" integer NOT NULL DEFAULT 10,
        "rating" numeric(3,1) NOT NULL DEFAULT 0,
        "reviewCount" integer NOT NULL DEFAULT 0,
        "status" "ride_status_enum" NOT NULL DEFAULT 'Active',
        "fairId" uuid,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),

        CONSTRAINT "PK_rides_id"
          PRIMARY KEY ("id"),

        CONSTRAINT "FK_rides_fair"
          FOREIGN KEY ("fairId")
          REFERENCES "fairs"("id")
          ON DELETE NO ACTION
          ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_rides_fairId"
      ON "rides" ("fairId")
    `);

    // ────────────────────────────────────────────────────────────────────────
    // PAYMENTS
    // ────────────────────────────────────────────────────────────────────────

    await queryRunner.query(`
      CREATE TABLE "payments" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "razorpayOrderId" character varying,
        "razorpayPaymentId" character varying,
        "razorpaySignature" character varying,
        "amount" numeric(10,2) NOT NULL,
        "currency" character varying(3) NOT NULL DEFAULT 'INR',
        "status" "payment_status_enum" NOT NULL DEFAULT 'Pending',
        "method" "payment_method_enum" NOT NULL,
        "gatewayResponse" jsonb,
        "quantity" integer NOT NULL DEFAULT 1,
        "customerId" uuid,
        "rideId" uuid,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),

        CONSTRAINT "PK_payments_id"
          PRIMARY KEY ("id"),

        CONSTRAINT "FK_payments_customer"
          FOREIGN KEY ("customerId")
          REFERENCES "users"("id")
          ON DELETE NO ACTION
          ON UPDATE NO ACTION,

        CONSTRAINT "FK_payments_ride"
          FOREIGN KEY ("rideId")
          REFERENCES "rides"("id")
          ON DELETE NO ACTION
          ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_payments_customerId"
      ON "payments" ("customerId")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_payments_rideId"
      ON "payments" ("rideId")
    `);

    // ────────────────────────────────────────────────────────────────────────
    // STAFF
    // ────────────────────────────────────────────────────────────────────────

    await queryRunner.query(`
      CREATE TABLE "staff" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "gate" character varying NOT NULL DEFAULT 'Gate 1',
        "isActive" boolean NOT NULL DEFAULT true,
        "scansToday" integer NOT NULL DEFAULT 0,
        "scansTotal" integer NOT NULL DEFAULT 0,
        "lastScanAt" TIMESTAMPTZ,
        "userId" uuid,
        "operatorId" uuid,
        "fairId" uuid,
        "assignedRideId" uuid,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),

        CONSTRAINT "PK_staff_id"
          PRIMARY KEY ("id"),

        CONSTRAINT "UQ_staff_user_fair"
          UNIQUE ("userId", "fairId"),

        CONSTRAINT "FK_staff_user"
          FOREIGN KEY ("userId")
          REFERENCES "users"("id")
          ON DELETE NO ACTION
          ON UPDATE NO ACTION,

        CONSTRAINT "FK_staff_operator"
          FOREIGN KEY ("operatorId")
          REFERENCES "operators"("id")
          ON DELETE NO ACTION
          ON UPDATE NO ACTION,

        CONSTRAINT "FK_staff_fair"
          FOREIGN KEY ("fairId")
          REFERENCES "fairs"("id")
          ON DELETE NO ACTION
          ON UPDATE NO ACTION,

        CONSTRAINT "FK_staff_assignedRide"
          FOREIGN KEY ("assignedRideId")
          REFERENCES "rides"("id")
          ON DELETE NO ACTION
          ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_staff_userId"
      ON "staff" ("userId")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_staff_operatorId"
      ON "staff" ("operatorId")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_staff_fairId"
      ON "staff" ("fairId")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_staff_assignedRideId"
      ON "staff" ("assignedRideId")
    `);

    // ────────────────────────────────────────────────────────────────────────
    // TICKETS
    // ────────────────────────────────────────────────────────────────────────

    await queryRunner.query(`
      CREATE TABLE "tickets" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "displayId" character varying NOT NULL,
        "quantity" integer NOT NULL,
        "pricePerPerson" numeric(10,2) NOT NULL,
        "totalAmount" numeric(10,2) NOT NULL,
        "paymentMethod" "payment_method_enum" NOT NULL,
        "paymentStatus" "payment_status_enum" NOT NULL DEFAULT 'Pending',
        "ticketStatus" "ticket_status_enum" NOT NULL DEFAULT 'Valid',
        "qrToken" character varying NOT NULL,
        "eventDate" date NOT NULL,
        "redeemedAt" TIMESTAMPTZ,
        "redeemedByStaffId" uuid,
        "redeemedAtGate" character varying,
        "customerId" uuid,
        "rideId" uuid,
        "fairId" uuid,
        "paymentId" uuid,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),

        CONSTRAINT "PK_tickets_id"
          PRIMARY KEY ("id"),

        CONSTRAINT "UQ_tickets_displayId"
          UNIQUE ("displayId"),

        CONSTRAINT "UQ_tickets_qrToken"
          UNIQUE ("qrToken"),

        CONSTRAINT "FK_tickets_redeemedByStaff"
          FOREIGN KEY ("redeemedByStaffId")
          REFERENCES "staff"("id")
          ON DELETE NO ACTION
          ON UPDATE NO ACTION,

        CONSTRAINT "FK_tickets_customer"
          FOREIGN KEY ("customerId")
          REFERENCES "users"("id")
          ON DELETE NO ACTION
          ON UPDATE NO ACTION,

        CONSTRAINT "FK_tickets_ride"
          FOREIGN KEY ("rideId")
          REFERENCES "rides"("id")
          ON DELETE NO ACTION
          ON UPDATE NO ACTION,

        CONSTRAINT "FK_tickets_fair"
          FOREIGN KEY ("fairId")
          REFERENCES "fairs"("id")
          ON DELETE NO ACTION
          ON UPDATE NO ACTION,

        CONSTRAINT "FK_tickets_payment"
          FOREIGN KEY ("paymentId")
          REFERENCES "payments"("id")
          ON DELETE NO ACTION
          ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_tickets_qrToken"
      ON "tickets" ("qrToken")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_tickets_displayId"
      ON "tickets" ("displayId")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_tickets_customerId"
      ON "tickets" ("customerId")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_tickets_rideId"
      ON "tickets" ("rideId")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_tickets_fairId"
      ON "tickets" ("fairId")
    `);

    // ────────────────────────────────────────────────────────────────────────
    // SCAN LOGS
    // ────────────────────────────────────────────────────────────────────────

    await queryRunner.query(`
      CREATE TABLE "scan_logs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "outcome" "scan_outcome_enum" NOT NULL,
        "scannedToken" character varying,
        "scannedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "gate" character varying,
        "staffId" uuid,
        "ticketId" uuid,

        CONSTRAINT "PK_scan_logs_id"
          PRIMARY KEY ("id"),

        CONSTRAINT "FK_scan_logs_staff"
          FOREIGN KEY ("staffId")
          REFERENCES "staff"("id")
          ON DELETE NO ACTION
          ON UPDATE NO ACTION,

        CONSTRAINT "FK_scan_logs_ticket"
          FOREIGN KEY ("ticketId")
          REFERENCES "tickets"("id")
          ON DELETE NO ACTION
          ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_scan_logs_staffId"
      ON "scan_logs" ("staffId")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_scan_logs_ticketId"
      ON "scan_logs" ("ticketId")
    `);

    // ────────────────────────────────────────────────────────────────────────
    // NOTIFICATIONS
    // ────────────────────────────────────────────────────────────────────────

    await queryRunner.query(`
      CREATE TABLE "notifications" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "type" "notification_type_enum" NOT NULL,
        "channel" "notification_channel_enum" NOT NULL DEFAULT 'IN_APP',
        "status" "notification_status_enum" NOT NULL DEFAULT 'PENDING',
        "recipientUserId" uuid,
        "recipientOperatorId" uuid,
        "payload" jsonb NOT NULL,
        "isRead" boolean NOT NULL DEFAULT false,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "sentAt" TIMESTAMPTZ,

        CONSTRAINT "PK_notifications_id"
          PRIMARY KEY ("id"),

        CONSTRAINT "FK_notifications_recipientUser"
          FOREIGN KEY ("recipientUserId")
          REFERENCES "users"("id")
          ON DELETE NO ACTION
          ON UPDATE NO ACTION,

        CONSTRAINT "FK_notifications_recipientOperator"
          FOREIGN KEY ("recipientOperatorId")
          REFERENCES "operators"("id")
          ON DELETE NO ACTION
          ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_notifications_recipientUser_createdAt"
      ON "notifications" ("recipientUserId", "createdAt")
    `);

    // ────────────────────────────────────────────────────────────────────────
    // OPERATOR TRANSACTIONS
    // ────────────────────────────────────────────────────────────────────────

    await queryRunner.query(`
      CREATE TABLE "operator_transactions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "type" "operator_transaction_type_enum" NOT NULL,
        "status" "operator_transaction_status_enum" NOT NULL DEFAULT 'PENDING',
        "amount" numeric(12,2) NOT NULL,
        "currency" character varying(3) NOT NULL DEFAULT 'INR',
        "operatorId" uuid,
        "gatewayReference" character varying,
        "gatewayResponse" jsonb,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),

        CONSTRAINT "PK_operator_transactions_id"
          PRIMARY KEY ("id"),

        CONSTRAINT "FK_operator_transactions_operator"
          FOREIGN KEY ("operatorId")
          REFERENCES "operators"("id")
          ON DELETE NO ACTION
          ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_operator_transactions_operatorId"
      ON "operator_transactions" ("operatorId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop in reverse dependency order.

    await queryRunner.query(`
      DROP TABLE IF EXISTS "operator_transactions"
    `);

    await queryRunner.query(`
      DROP TABLE IF EXISTS "notifications"
    `);

    await queryRunner.query(`
      DROP TABLE IF EXISTS "scan_logs"
    `);

    await queryRunner.query(`
      DROP TABLE IF EXISTS "tickets"
    `);

    await queryRunner.query(`
      DROP TABLE IF EXISTS "staff"
    `);

    await queryRunner.query(`
      DROP TABLE IF EXISTS "payments"
    `);

    await queryRunner.query(`
      DROP TABLE IF EXISTS "rides"
    `);

    await queryRunner.query(`
      DROP TABLE IF EXISTS "fairs"
    `);

    await queryRunner.query(`
      DROP TABLE IF EXISTS "operators"
    `);

    await queryRunner.query(`
      DROP TABLE IF EXISTS "users"
    `);

    await queryRunner.query(`
      DROP TYPE IF EXISTS "operator_transaction_status_enum"
    `);

    await queryRunner.query(`
      DROP TYPE IF EXISTS "operator_transaction_type_enum"
    `);

    await queryRunner.query(`
      DROP TYPE IF EXISTS "notification_status_enum"
    `);

    await queryRunner.query(`
      DROP TYPE IF EXISTS "notification_channel_enum"
    `);

    await queryRunner.query(`
      DROP TYPE IF EXISTS "notification_type_enum"
    `);

    await queryRunner.query(`
      DROP TYPE IF EXISTS "scan_outcome_enum"
    `);

    await queryRunner.query(`
      DROP TYPE IF EXISTS "payment_method_enum"
    `);

    await queryRunner.query(`
      DROP TYPE IF EXISTS "payment_status_enum"
    `);

    await queryRunner.query(`
      DROP TYPE IF EXISTS "ticket_status_enum"
    `);

    await queryRunner.query(`
      DROP TYPE IF EXISTS "ride_status_enum"
    `);

    await queryRunner.query(`
      DROP TYPE IF EXISTS "ride_category_enum"
    `);

    await queryRunner.query(`
      DROP TYPE IF EXISTS "fair_status_enum"
    `);

    await queryRunner.query(`
      DROP TYPE IF EXISTS "subscription_plan_enum"
    `);

    await queryRunner.query(`
      DROP TYPE IF EXISTS "user_role_enum"
    `);
  }
}
