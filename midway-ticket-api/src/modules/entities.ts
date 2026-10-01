// ─────────────────────────────────────────────────────────────────────────────
// MidwayTicket — TypeORM Entities
// Every entity maps to a PostgreSQL table. Relationships are explicit.
// ─────────────────────────────────────────────────────────────────────────────

import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  UpdateDateColumn, ManyToOne, OneToMany, JoinColumn, Index, Unique, Relation,
  RelationId, ValueTransformer,
} from "typeorm";

/**
 * FIX: Postgres `numeric`/`decimal` columns come back from `pg` (and thus
 * TypeORM) as STRINGS by default — not JS numbers — to avoid silent
 * floating-point precision loss. Every `type: "decimal"` column below was
 * typed as `number` in TypeScript but actually returned a string at
 * runtime. That's a silent contract break with real consequences:
 * `0 + ticket.totalAmount` string-concatenates instead of adding,
 * `formatCurrency(ride.pricePerPerson)` skips thousands separators, and any
 * strict `typeof x === "number"` check (as used in the hardened
 * `formatCurrency` on the frontend) treats a valid price as invalid.
 * A shared transformer applied to every decimal column fixes this once, at
 * the ORM boundary, instead of needing `Number(...)` coercion at every call
 * site across both codebases.
 */
const decimalTransformer: ValueTransformer = {
  to: (value?: number | null) => value,
  from: (value?: string | null) => (value === null || value === undefined ? value : parseFloat(value)),
};

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

  @Column({ select: false, nullable: true })
  // Nullable: a guest-checkout or Google-only account never sets one.
  // bcrypt.compare() against null/undefined is guarded explicitly wherever
  // this is read (see AuthService.loginWithRole) — never assume it's set.
  passwordHash: string;

  // Set once a Google sign-in has been linked to this account (see
  // AuthService.googleAuth). Guest-checkout accounts have this null until
  // the person actually signs in with Google using the same email.
  @Column({ nullable: true, unique: true })
  googleId: string;

  @Column({ type: "enum", enum: UserRole, default: UserRole.CUSTOMER })
  role: UserRole;

  @Column({ default: true })
  isActive: boolean;

  // ── Email verification ──────────────────────────────────────────────────
  @Column({ default: false })
  emailVerified: boolean;

  // Hashed (SHA-256), never the raw token — same reasoning as passwordHash:
  // a DB dump should never hand out usable tokens. select:false so it's
  // never returned by a plain find()/findOne() by accident.
  @Column({ nullable: true, select: false })
  emailVerificationTokenHash: string;

  @Column({ type: "timestamptz", nullable: true })
  emailVerificationExpiresAt: Date;

  // ── Password reset ───────────────────────────────────────────────────────
  @Column({ nullable: true, select: false })
  passwordResetTokenHash: string;

  @Column({ type: "timestamptz", nullable: true })
  passwordResetExpiresAt: Date;

  // Set every time the password changes (registration doesn't count — only
  // an actual reset/change). JwtStrategy compares this against the token's
  // `iat` claim so that any JWT issued BEFORE a password reset stops working
  // immediately, instead of staying valid until its natural 7-day expiry —
  // closing the "leaked old token still works after reset" gap.
  @Column({ type: "timestamptz", nullable: true })
  passwordChangedAt: Date;

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

  @OneToMany(() => EventEntity, (e) => e.operator)
  events: EventEntity[];

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

  /**
   * FIX: same issue as RideEntity.fairId — the frontend's `Fair` type
   * expects a flat `operatorId` string, but this entity only ever exposed
   * the full `operator` relation object. `@RelationId` reads the existing
   * FK column (no migration) and populates this scalar automatically.
   */
  @RelationId((fair: FairEntity) => fair.operator)
  operatorId: string;

  @OneToMany(() => RideEntity, (r) => r.fair)
  rides: RideEntity[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

// ── EVENT ─────────────────────────────────────────────────────────────────────
// A standalone event an operator hosts directly — NOT under a Fair and NOT
// broken into Rides. e.g. a college auditorium show, a standalone concert, a
// single-venue ticketed gathering. Kept as its own top-level entity (rather
// than shoehorned into Fair/Ride) since it has none of a fair's multi-ride
// structure — just one thing, one price, one capacity.

export enum EventStatus { DRAFT = "DRAFT", ACTIVE = "ACTIVE", ENDED = "ENDED" }

@Entity("events")
export class EventEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column()
  name: string;

  @Column({ type: "text", nullable: true })
  description: string;

  @Column()
  venue: string;

  @Column()
  city: string;

  @Column({ type: "date" })
  eventDate: string;

  @Column({ nullable: true })
  coverImageUrl: string;

  @Column({ nullable: true })
  coverGradient: string;

  @Column({ nullable: true })
  emoji: string;

  @Column({ type: "int", default: 100 })
  capacity: number;

  @Column({ type: "decimal", precision: 10, scale: 2, default: 0, transformer: decimalTransformer })
  pricePerTicket: number;

  /**
   * The operator's own choice, per event: if false, no payment method is
   * ever presented to a customer booking this event and the ticket is
   * issued immediately, free — this is the whole point of Events existing
   * separately from paid Rides. If true (and payments are globally enabled
   * on this deployment), booking goes through the same Razorpay order/verify
   * flow as a ride booking.
   */
  @Column({ default: false })
  requiresPayment: boolean;

  @Column({ type: "enum", enum: EventStatus, default: EventStatus.DRAFT })
  status: EventStatus;

  @ManyToOne(() => OperatorEntity, (o) => o.events)
  @JoinColumn()
  operator: OperatorEntity;

  @RelationId((event: EventEntity) => event.operator)
  operatorId: string;

  @OneToMany(() => TicketEntity, (t) => t.event)
  tickets: TicketEntity[];

  @OneToMany(() => StaffEntity, (s) => s.assignedEvent)
  assignedStaff: Relation<StaffEntity[]>;

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

  @Column({ type: "decimal", precision: 10, scale: 2, transformer: decimalTransformer })
  pricePerPerson: number;

  @Column({ type: "int", default: 5 })
  durationMinutes: number;

  @Column({ type: "int", nullable: true })
  minAge: number;

  @Column({ type: "int", default: 10 })
  capacity: number;

  @Column({ type: "decimal", precision: 3, scale: 1, default: 0, transformer: decimalTransformer })
  rating: number;

  @Column({ type: "int", default: 0 })
  reviewCount: number;

  @Column({ type: "enum", enum: RideStatus, default: RideStatus.ACTIVE })
  status: RideStatus;

  @ManyToOne(() => FairEntity, (f) => f.rides)
  @JoinColumn()
  fair: FairEntity;

  /**
   * FIX: the frontend's `Ride` type has always expected a flat `fairId`
   * string (used for the ride-detail page's "back to fair" link, the cart
   * item, and checkout display) — but this entity only ever exposed the
   * full `fair` relation object, and only when it was explicitly eager-
   * loaded. Every real (non-mock) API response had `fairId: undefined`.
   * `@RelationId` reads the same foreign-key column the `fair` relation
   * already uses — no new DB column, no migration — and populates this
   * scalar automatically on ordinary `find()`/`findOne()` calls, even when
   * `fair` itself isn't eager-loaded.
   */
  @RelationId((ride: RideEntity) => ride.fair)
  fairId: string;

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

  @Column({ type: "decimal", precision: 10, scale: 2, transformer: decimalTransformer })
  pricePerPerson: number;

  @Column({ type: "decimal", precision: 10, scale: 2, transformer: decimalTransformer })
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

  @ManyToOne(() => RideEntity, (r) => r.tickets, { nullable: true })
  @JoinColumn()
  ride: RideEntity;

  @ManyToOne(() => FairEntity, { nullable: true })
  @JoinColumn()
  fair: FairEntity;

  // Set instead of ride/fair when this ticket is for a standalone Event
  // booking (see EventEntity) — a ticket is for a ride+fair OR an event,
  // never both.
  @ManyToOne(() => EventEntity, (e) => e.tickets, { nullable: true })
  @JoinColumn()
  event: EventEntity;

  @RelationId((ticket: TicketEntity) => ticket.event)
  eventId: string;

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

  @Column({ type: "decimal", precision: 10, scale: 2, transformer: decimalTransformer })
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

  // Only set for a standalone Event booking (see EventEntity) — mutually
  // exclusive with `ride` above; a payment is for one or the other.
  @ManyToOne(() => EventEntity, { nullable: true })
  @JoinColumn()
  event: EventEntity;

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

  @ManyToOne(() => FairEntity, { nullable: true })
  @JoinColumn()
  fair: FairEntity;

  /**
   * The ONLY ride this staff member can scan.
   * Backend enforces: if ticket.rideId !== staff.assignedRide.id → WRONG_RIDE
   * Nullable: a staff member is assigned to EITHER a ride (fair-based) OR a
   * standalone event (assignedEvent below), never both.
   */
  @ManyToOne(() => RideEntity, (r) => r.assignedStaff, { nullable: true })
  @JoinColumn()
  assignedRide: RideEntity;

  /** The ONLY standalone event this staff member can scan (see EventEntity). */
  @ManyToOne(() => EventEntity, (e) => e.assignedStaff, { nullable: true })
  @JoinColumn()
  assignedEvent: EventEntity;

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
  // The ticket and ride/event assignment both check out, but the ride is
  // Paused/Maintenance or its fair has ENDED (or the standalone event has
  // ENDED) — a real, distinct front-of-gate scenario from "wrong ride",
  // where the ticket just isn't valid ANYWHERE right now.
  RIDE_CLOSED  = "RIDE_CLOSED",
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

  @Column({ type: "decimal", precision: 12, scale: 2, transformer: decimalTransformer })
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
