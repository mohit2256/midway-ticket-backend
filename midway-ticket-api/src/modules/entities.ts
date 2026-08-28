// ─────────────────────────────────────────────────────────────────────────────
// MidwayTicket — TypeORM Entities
// Every entity maps to a PostgreSQL table. Relationships are explicit.
// ─────────────────────────────────────────────────────────────────────────────

import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  UpdateDateColumn, ManyToOne, OneToMany, JoinColumn, Index, Unique, Relation,
} from "typeorm";

// ── USER / ROLES ──────────────────────────────────────────────────────────────

export enum UserRole {
  CUSTOMER        = "CUSTOMER",
  OPERATOR_OWNER  = "OPERATOR_OWNER",
  OPERATOR_MANAGER= "OPERATOR_MANAGER",
  SCANNER_STAFF   = "SCANNER_STAFF",
}

@Entity("users")
export class UserEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column()
  name: string;

  @Column({ unique: true })
  @Index()
  email: string;

  @Column({ nullable: true })
  phone: string;

  @Column({ select: false })         // never returned in queries
  passwordHash: string;

  @Column({ type: "enum", enum: UserRole, default: UserRole.CUSTOMER })
  role: UserRole;

  @Column({ default: true })
  isActive: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  // Relations
  @OneToMany(() => TicketEntity, (t) => t.customer)
  tickets: TicketEntity[];

  @OneToMany(() => OperatorEntity, (o) => o.owner)
  operators: OperatorEntity[];
}

// ── OPERATOR ──────────────────────────────────────────────────────────────────

export enum SubscriptionPlan {
  TRIAL      = "TRIAL",
  STARTER    = "STARTER",
  GROWTH     = "GROWTH",
  ENTERPRISE = "ENTERPRISE",
}

@Entity("operators")
export class OperatorEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column()
  name: string;          // e.g. "Grand City Mela Events Pvt Ltd"

  @Column({ type: "enum", enum: SubscriptionPlan, default: SubscriptionPlan.TRIAL })
  plan: SubscriptionPlan;

  @Column({ nullable: true })
  planExpiresAt: Date;

  // Future payout feature (not active yet): where operator earnings would be
  // sent. Nullable/unused until the payouts feature ships — added now so
  // that feature is a migration + service, not a schema rebuild.
  @Column({ nullable: true })
  payoutAccountId: string;

  @Column({ default: true })
  isActive: boolean;

  @ManyToOne(() => UserEntity, (u) => u.operators)
  @JoinColumn()
  owner: UserEntity;

  @OneToMany(() => FairEntity, (f) => f.operator)
  fairs: FairEntity[];

  @OneToMany(() => StaffEntity, (s) => s.operator)
  staff: Relation<StaffEntity[]>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

// ── FAIR ──────────────────────────────────────────────────────────────────────

export enum FairStatus { DRAFT = "DRAFT", ACTIVE = "ACTIVE", ENDED = "ENDED" }

@Entity("fairs")
export class FairEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column()
  name: string;

  @Column()
  location: string;

  @Column()
  city: string;

  @Column({ type: "date" })
  startDate: string;

  @Column({ type: "date" })
  endDate: string;

  @Column({ type: "text", nullable: true })
  description: string;

  @Column({ nullable: true })
  coverImageUrl: string;

  @Column({ nullable: true })
  coverGradient: string;

  @Column({ nullable: true })
  emoji: string;

  @Column({ type: "enum", enum: FairStatus, default: FairStatus.DRAFT })
  status: FairStatus;

  @ManyToOne(() => OperatorEntity, (o) => o.fairs)
  @JoinColumn()
  operator: OperatorEntity;

  @OneToMany(() => RideEntity, (r) => r.fair)
  rides: RideEntity[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

// ── RIDE ──────────────────────────────────────────────────────────────────────

export enum RideCategory { THRILL = "Thrill", FAMILY = "Family", KIDS = "Kids", GAMES = "Games" }
export enum RideStatus   { ACTIVE = "Active", PAUSED = "Paused", MAINTENANCE = "Maintenance" }

@Entity("rides")
export class RideEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column()
  name: string;

  @Column({ type: "text", nullable: true })
  description: string;

  @Column({ type: "enum", enum: RideCategory })
  category: RideCategory;

  @Column({ nullable: true })
  emoji: string;

  @Column({ nullable: true })
  coverGradient: string;

  @Column({ type: "decimal", precision: 10, scale: 2 })
  pricePerPerson: number;

  @Column({ type: "int", default: 5 })
  durationMinutes: number;

  @Column({ type: "int", nullable: true })
  minAge: number;

  @Column({ type: "int", default: 10 })
  capacity: number;

  @Column({ type: "decimal", precision: 3, scale: 1, default: 0 })
  rating: number;

  @Column({ type: "int", default: 0 })
  reviewCount: number;

  @Column({ type: "enum", enum: RideStatus, default: RideStatus.ACTIVE })
  status: RideStatus;

  @ManyToOne(() => FairEntity, (f) => f.rides)
  @JoinColumn()
  fair: FairEntity;

  @OneToMany(() => StaffEntity, (s) => s.assignedRide)
  assignedStaff: Relation<StaffEntity[]>;

  @OneToMany(() => TicketEntity, (t) => t.ride)
  tickets: TicketEntity[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

// ── TICKET ────────────────────────────────────────────────────────────────────

export enum TicketStatus  { VALID = "Valid", USED = "Used", EXPIRED = "Expired", CANCELLED = "Cancelled" }
export enum PaymentStatus { PENDING = "Pending", PAID = "Paid", FAILED = "Failed", REFUNDED = "Refunded" }
export enum PaymentMethod { UPI = "UPI", CARD = "Card", NET_BANKING = "NetBanking", WALLET = "Wallet", FREE = "Free" }

@Entity("tickets")
@Index(["qrToken"], { unique: true })
export class TicketEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  /** Human-readable ID shown on ticket e.g. MT28491 */
  @Column({ unique: true })
  @Index()
  displayId: string;

  @Column()
  quantity: number;

  @Column({ type: "decimal", precision: 10, scale: 2 })
  pricePerPerson: number;

  @Column({ type: "decimal", precision: 10, scale: 2 })
  totalAmount: number;

  @Column({ type: "enum", enum: PaymentMethod })
  paymentMethod: PaymentMethod;

  @Column({ type: "enum", enum: PaymentStatus, default: PaymentStatus.PENDING })
  paymentStatus: PaymentStatus;

  @Column({ type: "enum", enum: TicketStatus, default: TicketStatus.VALID })
  ticketStatus: TicketStatus;

  /**
   * Cryptographically unique token stored in QR code.
   * The QR image embeds only this token — NOT any plaintext user data.
   * Validation: POST /tickets/:token/redeem checks this column atomically.
   */
  @Column({ unique: true, select: false })
  qrToken: string;

  @Column({ type: "date" })
  eventDate: string;

  // Redemption tracking
  @Column({ type: "timestamptz", nullable: true })
  redeemedAt: Date;

  @ManyToOne(() => StaffEntity, { nullable: true })
  @JoinColumn()
  redeemedByStaff: Relation<StaffEntity>;

  @Column({ nullable: true })
  redeemedAtGate: string;

  // Relations
  @ManyToOne(() => UserEntity, (u) => u.tickets)
  @JoinColumn()
  customer: UserEntity;

  @ManyToOne(() => RideEntity, (r) => r.tickets)
  @JoinColumn()
  ride: RideEntity;

  @ManyToOne(() => FairEntity)
  @JoinColumn()
  fair: FairEntity;

  @ManyToOne(() => PaymentEntity, { nullable: true })
  @JoinColumn()
  payment: Relation<PaymentEntity>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

// ── PAYMENT ───────────────────────────────────────────────────────────────────

@Entity("payments")
export class PaymentEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ nullable: true })
  razorpayOrderId: string;

  @Column({ nullable: true })
  razorpayPaymentId: string;

  @Column({ nullable: true })
  razorpaySignature: string;

  @Column({ type: "decimal", precision: 10, scale: 2 })
  amount: number;

  @Column({ length: 3, default: "INR" })
  currency: string;

  @Column({ type: "enum", enum: PaymentStatus, default: PaymentStatus.PENDING })
  status: PaymentStatus;

  @Column({ type: "enum", enum: PaymentMethod })
  method: PaymentMethod;

  @Column({ type: "jsonb", nullable: true })
  gatewayResponse: Record<string, unknown>;

  // Needed at verification time to lock the correct ride row and check
  // capacity before issuing a ticket (see BookingsService.verifyAndIssueTicket).
  @Column({ type: "int", default: 1 })
  quantity: number;

  @ManyToOne(() => UserEntity)
  @JoinColumn()
  customer: UserEntity;

  @ManyToOne(() => RideEntity, { nullable: true })
  @JoinColumn()
  ride: RideEntity;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

// ── STAFF ─────────────────────────────────────────────────────────────────────

@Entity("staff")
@Unique(["user", "fair"])            // one staff account per fair per user
export class StaffEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ default: "Gate 1" })
  gate: string;

  @Column({ default: true })
  isActive: boolean;

  @Column({ type: "int", default: 0 })
  scansToday: number;

  @Column({ type: "int", default: 0 })
  scansTotal: number;

  @Column({ type: "timestamptz", nullable: true })
  lastScanAt: Date;

  // Relations — critical for scanner authorisation
  @ManyToOne(() => UserEntity)
  @JoinColumn()
  user: UserEntity;

  @ManyToOne(() => OperatorEntity, (o) => o.staff)
  @JoinColumn()
  operator: OperatorEntity;

  @ManyToOne(() => FairEntity)
  @JoinColumn()
  fair: FairEntity;

  /**
   * The ONLY ride this staff member can scan.
   * Backend enforces: if ticket.rideId !== staff.assignedRide.id → WRONG_RIDE
   */
  @ManyToOne(() => RideEntity, (r) => r.assignedStaff)
  @JoinColumn()
  assignedRide: RideEntity;

  @OneToMany(() => ScanLogEntity, (sl) => sl.staff)
  scanLogs: ScanLogEntity[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

// ── SCAN LOG ──────────────────────────────────────────────────────────────────

export enum ScanOutcome {
  VALID        = "VALID",
  WRONG_RIDE   = "WRONG_RIDE",
  ALREADY_USED = "ALREADY_USED",
  INVALID      = "INVALID",
  EXPIRED      = "EXPIRED",
  PAYMENT_FAIL = "PAYMENT_FAIL",
}

@Entity("scan_logs")
export class ScanLogEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "enum", enum: ScanOutcome })
  outcome: ScanOutcome;

  @Column({ nullable: true })
  scannedToken: string;   // the raw QR token that was presented

  @Column({ type: "timestamptz", default: () => "CURRENT_TIMESTAMP" })
  scannedAt: Date;

  @Column({ nullable: true })
  gate: string;

  @ManyToOne(() => StaffEntity, (s) => s.scanLogs)
  @JoinColumn()
  staff: StaffEntity;

  // NOTE: tickets is a RANGE-partitioned table (see migrations/
  // ...PartitionTicketsByEventDate). Postgres can't enforce a DB-level FK
  // to a partitioned table's id alone, so this relation is ORM-level only
  // (joins still work fine via the column value) — referential integrity
  // here is an application guarantee, not a DB constraint.
  @ManyToOne(() => TicketEntity, { nullable: true })
  @JoinColumn()
  ticket: TicketEntity;
}

// ── NOTIFICATION ──────────────────────────────────────────────────────────────
// Written by NotificationsProcessor (BullMQ worker), NOT inline in the
// booking/scan transaction. This is the "eventual consistency" boundary:
// the booking/scan itself commits immediately (strong consistency), and the
// notification row + delivery happens a moment later, off the request path.

export enum NotificationType {
  TICKET_ISSUED    = "TICKET_ISSUED",
  TICKET_SCANNED   = "TICKET_SCANNED",
  RIDE_SOLD_OUT    = "RIDE_SOLD_OUT",
  PAYMENT_FAILED   = "PAYMENT_FAILED",
}

export enum NotificationChannel { IN_APP = "IN_APP", EMAIL = "EMAIL", PUSH = "PUSH" }
export enum NotificationStatus  { PENDING = "PENDING", SENT = "SENT", FAILED = "FAILED" }

@Entity("notifications")
@Index(["recipientUser", "createdAt"])
export class NotificationEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "enum", enum: NotificationType })
  type: NotificationType;

  @Column({ type: "enum", enum: NotificationChannel, default: NotificationChannel.IN_APP })
  channel: NotificationChannel;

  @Column({ type: "enum", enum: NotificationStatus, default: NotificationStatus.PENDING })
  status: NotificationStatus;

  // Who sees this in-app. Nullable because some notifications (e.g. sold-out)
  // target an operator dashboard rather than a single user.
  @ManyToOne(() => UserEntity, { nullable: true })
  @JoinColumn()
  recipientUser: UserEntity;

  @ManyToOne(() => OperatorEntity, { nullable: true })
  @JoinColumn()
  recipientOperator: OperatorEntity;

  @Column({ type: "jsonb" })
  payload: Record<string, unknown>;   // e.g. { ticketId, displayId, rideName }

  @Column({ default: false })
  isRead: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: "timestamptz", nullable: true })
  sentAt: Date;
}

// ── OPERATOR TRANSACTION (skeleton — future payouts feature) ──────────────────
// No logic reads or writes this table yet. It exists purely so the payouts
// feature (paying operators their share of ticket revenue) is a service +
// migration to ADD, not a schema change to every existing table. Do not wire
// this up until payouts are actually being built.

export enum OperatorTransactionType   { PAYOUT = "PAYOUT", ADJUSTMENT = "ADJUSTMENT", REFUND_DEBIT = "REFUND_DEBIT" }
export enum OperatorTransactionStatus { PENDING = "PENDING", PROCESSING = "PROCESSING", COMPLETED = "COMPLETED", FAILED = "FAILED" }

@Entity("operator_transactions")
export class OperatorTransactionEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "enum", enum: OperatorTransactionType })
  type: OperatorTransactionType;

  @Column({ type: "enum", enum: OperatorTransactionStatus, default: OperatorTransactionStatus.PENDING })
  status: OperatorTransactionStatus;

  @Column({ type: "decimal", precision: 12, scale: 2 })
  amount: number;

  @Column({ length: 3, default: "INR" })
  currency: string;

  @ManyToOne(() => OperatorEntity)
  @JoinColumn()
  operator: OperatorEntity;

  // Populated once a real payout gateway (Razorpay Route / RazorpayX etc.)
  // is integrated. Left generic on purpose — no gateway-specific columns yet.
  @Column({ nullable: true })
  gatewayReference: string;

  @Column({ type: "jsonb", nullable: true })
  gatewayResponse: Record<string, unknown>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
