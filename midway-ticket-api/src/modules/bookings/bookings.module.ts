// ═══════════════════════════════════════════════════════════════════════════════
// BOOKINGS MODULE
// Flow: Customer selects ride → CreateBooking → Razorpay order created
//       → Frontend redirects to payment → Webhook confirms → Ticket issued
// ═══════════════════════════════════════════════════════════════════════════════

import {
  Injectable, NotFoundException, BadRequestException, ForbiddenException, Logger,
} from "@nestjs/common";
import { InjectRepository, InjectDataSource } from "@nestjs/typeorm";
import { Repository, DataSource, In } from "typeorm";
import { ConfigService } from "@nestjs/config";
import Razorpay from "razorpay";
import * as crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import {
  IsUUID, IsInt, Min, Max, IsEnum, IsEmail, IsString, IsOptional,
} from "class-validator";
import { Type } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  Controller, Post, Body, Param, Headers, RawBodyRequest, Req,
  UseGuards, HttpCode, HttpStatus, Get,
} from "@nestjs/common";
import { ApiTags, ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { Request } from "express";
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { EmailModule } from "../email/email.module";

import {
  TicketEntity, PaymentEntity, RideEntity, FairEntity, OperatorEntity,
  UserEntity, TicketStatus, PaymentStatus, PaymentMethod, NotificationType,
} from "../entities";
import { JwtAuthGuard, CurrentUser, Roles, RolesGuard } from "../../common/guards/auth.guards";
import { UserRole } from "../entities";
import { NotificationsService } from "../notifications/notifications.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { TicketEmailService } from "../email/ticket-email.service";
import { toTicketDto } from "../tickets/tickets.module";

// ── DTOs ──────────────────────────────────────────────────────────────────────

export class CreateBookingDto {
  @ApiProperty() @IsUUID()  rideId:  string;
  @ApiProperty() @IsInt() @Min(1) @Max(10) @Type(() => Number) quantity: number;
  // Only meaningful once PAYMENTS_ENABLED=true. Frontend can omit this
  // entirely in launch mode; validation below allows it to be absent.
  @ApiPropertyOptional() @IsOptional() @IsEnum(PaymentMethod) paymentMethod?: PaymentMethod;
  @ApiPropertyOptional() @IsEmail()  @IsString() customerEmail?: string;
}

export class VerifyPaymentDto {
  @ApiProperty() @IsString() razorpayOrderId:    string;
  @ApiProperty() @IsString() razorpayPaymentId:  string;
  @ApiProperty() @IsString() razorpaySignature:  string;
}

/**
 * Operator-only "issue a ticket without payment" tool. Completely separate
 * from the customer checkout flow (CreateBookingDto above) — there is no
 * payment method field here at all, on purpose: for this action a payment
 * option should never be shown or accepted, full stop. Meant for an
 * organizer to generate a real ticket + QR for their own ride to test that
 * the QR renders and scans correctly at the gate, without needing a real
 * paying customer or Razorpay wired up.
 */
export class IssueTestTicketDto {
  @ApiProperty() @IsUUID() rideId: string;
  @ApiPropertyOptional({ default: 1 })
  @IsOptional() @IsInt() @Min(1) @Max(10) @Type(() => Number)
  quantity?: number;
  // Leave blank to issue the ticket to your own (operator) account — the
  // simplest path for a quick QR/scanner test. Provide an email only if you
  // want the test ticket attached to a specific existing customer account.
  @ApiPropertyOptional() @IsOptional() @IsEmail() customerEmail?: string;
}

// ── Service ───────────────────────────────────────────────────────────────────

import { Inject } from "@nestjs/common";
import { CACHE_MANAGER } from "@nestjs/cache-manager";
import { Cache } from "cache-manager";
import { ConflictException } from "@nestjs/common";

@Injectable()
export class BookingsService {
  private readonly logger   = new Logger(BookingsService.name);
  private readonly razorpay: Razorpay | null;
  private readonly paymentsEnabled: boolean;

  // Idempotency keys expire after 24 h — long enough to cover any
  // reasonable retry window, short enough that Redis memory stays bounded.
  private readonly IDEMPOTENCY_TTL_MS = 86_400_000;

  constructor(
    @InjectRepository(TicketEntity)  private tickets:  Repository<TicketEntity>,
    @InjectRepository(PaymentEntity) private payments: Repository<PaymentEntity>,
    @InjectRepository(RideEntity)    private rides:    Repository<RideEntity>,
    @InjectRepository(FairEntity)    private fairs:    Repository<FairEntity>,
    @InjectRepository(UserEntity)    private users:    Repository<UserEntity>,
    @InjectRepository(OperatorEntity) private operators: Repository<OperatorEntity>,
    @InjectDataSource()              private db:       DataSource,
    private readonly ticketEmail:    TicketEmailService,
    private readonly config:         ConfigService,
    private readonly notifications:  NotificationsService,
    @Inject(CACHE_MANAGER)           private cache:    Cache,
  ) {
    this.paymentsEnabled = this.config.get("app.paymentsEnabled", false);
    this.razorpay = this.paymentsEnabled
      ? new Razorpay({
          key_id:     config.get("app.razorpay.keyId",     "rzp_test_key"),
          key_secret: config.get("app.razorpay.keySecret", "rzp_test_secret"),
        })
      : null;
  }

  /**
   * Create a booking.
   *
   * Idempotency: If the caller provides an `Idempotency-Key` header (a UUID
   * generated by the frontend before the first attempt), subsequent retries
   * with the same key return the cached response instead of creating a second
   * ticket.  The key is scoped to the userId so one user cannot replay
   * another's key.  Keys expire after 24 h (IDEMPOTENCY_TTL_MS above).
   *
   * Launch mode (PAYMENTS_ENABLED=false): validates capacity under lock and
   * issues the ticket immediately — single round trip.
   *
   * Payments mode (PAYMENTS_ENABLED=true, future): creates a Razorpay order
   * + PENDING payment row; verifyAndIssueTicket() does capacity check +
   * ticket issuance once the frontend confirms payment.
   */
  async createBooking(userId: string, dto: CreateBookingDto, idempotencyKey?: string) {
    if (!idempotencyKey) {
      return this._createBookingInternal(userId, dto);
    }

    // ── Idempotency check ──────────────────────────────────────────────────
    // FIX: the previous implementation did `cache.get()` then, after the
    // booking finished, `cache.set()` — a classic check-then-act race. Two
    // near-simultaneous requests with the same key (e.g. a double-tap on
    // "Pay Now", or a frontend retry firing before the first response lands)
    // could both see "not cached yet" and both create a ticket.
    //
    // Fix: atomically CLAIM the key first (Redis `SET key val NX`), before
    // doing any booking work. Only the request that wins the claim creates
    // the ticket; anyone else with the same key waits briefly and receives
    // the winner's result instead of creating a duplicate.
    const cacheKey = `idempotency:booking:${userId}:${idempotencyKey}`;

    const claimed = await this.tryClaimIdempotencyKey(cacheKey);

    if (!claimed) {
      // Either a previous attempt already finished (cached final result), or
      // one is in flight right now (short-lived "processing" placeholder).
      const cached: any = await this.cache.get(cacheKey);
      if (cached && cached.__status !== "processing") {
        this.logger.log(`Idempotent replay for key=${idempotencyKey} user=${userId}`);
        return cached;
      }
      const result = await this.awaitIdempotentResult(cacheKey);
      if (result) return result;
      throw new ConflictException(
        "This booking is already being processed. Please wait a moment before retrying.",
      );
    }

    try {
      const result = await this._createBookingInternal(userId, dto);
      await this.cache.set(cacheKey, result, this.IDEMPOTENCY_TTL_MS);
      return result;
    } catch (err) {
      // Don't leave the "processing" placeholder stuck behind on failure —
      // that would permanently block retries using the same key. Wrapped in
      // try/catch (not `.catch()` chaining) so this cleanup can never mask
      // the original booking error, even if `del` itself is unavailable.
      try {
        await this.cache.del(cacheKey);
      } catch {
        /* best-effort cleanup only — the 30s claim TTL is the real safety net */
      }
      throw err;
    }
  }

  /**
   * Atomically claim an idempotency key so only one concurrent request
   * proceeds to create the booking. Uses the underlying Redis client's
   * `SET key val NX PX <ms>` (available via cache-manager-redis-yet), which
   * is a single atomic operation — unlike a separate get+set.
   *
   * Falls back to a best-effort (non-atomic) check if the raw client isn't
   * reachable for any reason (e.g. a different cache store in tests), rather
   * than throwing and breaking booking entirely — this keeps the fallback
   * behaviour identical to what shipped before this fix.
   */
  private async tryClaimIdempotencyKey(cacheKey: string): Promise<boolean> {
    try {
      const client = (this.cache as any)?.store?.client;
      if (client?.set) {
        const res = await client.set(
          cacheKey,
          JSON.stringify({ __status: "processing" }),
          { NX: true, PX: 30_000 }, // short claim window — just long enough to finish one booking
        );
        return res === "OK";
      }
    } catch (err) {
      this.logger.warn(`Idempotency claim via raw client failed, falling back: ${err}`);
    }
    const existing = await this.cache.get(cacheKey);
    return !existing;
  }

  /** Poll briefly for the in-flight request (that won the claim) to finish. */
  private async awaitIdempotentResult(cacheKey: string, attempts = 10, delayMs = 300) {
    for (let i = 0; i < attempts; i++) {
      await new Promise((r) => setTimeout(r, delayMs));
      const cached: any = await this.cache.get(cacheKey);
      if (cached && cached.__status !== "processing") return cached;
    }
    return null;
  }

  private async _createBookingInternal(userId: string, dto: CreateBookingDto) {
    const ride = await this.rides.findOne({
      where: { id: dto.rideId },
      relations: ["fair"],
    });
    if (!ride) throw new NotFoundException("Ride not found");
    if (ride.status !== "Active") throw new BadRequestException("This ride is not currently available");

    const totalAmount = ride.pricePerPerson * dto.quantity;

    if (!this.paymentsEnabled) {
      return this.issueFreeTicket(userId, ride, dto.quantity, totalAmount);
    }

    const order = await this.razorpay!.orders.create({
      amount:   totalAmount * 100,
      currency: "INR",
      receipt:  `mt_${Date.now()}`,
    }).catch((err) => {
      this.logger.error("Razorpay order creation failed", err);
      throw new BadRequestException("Payment gateway error. Please try again.");
    });

    const payment = this.payments.create({
      razorpayOrderId: order.id,
      amount:          totalAmount,
      currency:        "INR",
      status:          PaymentStatus.PENDING,
      method:          dto.paymentMethod,
      quantity:        dto.quantity,
      customer:        { id: userId } as UserEntity,
      ride:            { id: ride.id } as RideEntity,
    });
    await this.payments.save(payment);

    return {
      orderId:     order.id,
      amount:      totalAmount,
      currency:    "INR",
      paymentId:   payment.id,
      rideDetails: {
        name:           ride.name,
        fairName:       ride.fair?.name,
        quantity:       dto.quantity,
        pricePerPerson: ride.pricePerPerson,
      },
      razorpayKeyId: this.config.get("app.razorpay.keyId"),
    };
  }

  private async issueFreeTicket(
    userId: string,
    ride: RideEntity,
    quantity: number,
    totalAmount: number,
  ) {
    return this.db.transaction("READ COMMITTED", async (em) => {
      const lockedRide = await em.getRepository(RideEntity)
        .createQueryBuilder("ride")
        .leftJoinAndSelect("ride.fair", "fair")
        .setLock("pessimistic_write")
        .where("ride.id = :id", { id: ride.id })
        .getOne();

      if (!lockedRide) throw new NotFoundException("Ride not found");

      // Count SEATS booked, not ticket rows. A single ticket row can cover
      // multiple people (quantity > 1) — .count() would undercount capacity
      // usage whenever any booking has quantity > 1, silently allowing
      // overselling. SUM(quantity) is the actual number of seats taken.
      const { total } = await em.getRepository(TicketEntity)
        .createQueryBuilder("t")
        .select("COALESCE(SUM(t.quantity), 0)", "total")
        .where("t.rideId = :rideId", { rideId: lockedRide.id })
        .andWhere("t.ticketStatus = :status", { status: TicketStatus.VALID })
        .getRawOne();
      const bookedCount = Number(total);

      if (bookedCount + quantity > lockedRide.capacity) {
        this.notifications.enqueue({
          type:    NotificationType.RIDE_SOLD_OUT,
          fairId:  lockedRide.fair?.id,
          payload: { rideId: lockedRide.id, rideName: lockedRide.name },
        });
        throw new BadRequestException("This ride just sold out.");
      }

      const payment = em.getRepository(PaymentEntity).create({
        amount:   totalAmount,
        currency: "INR",
        status:   PaymentStatus.PAID,
        method:   PaymentMethod.FREE,
        quantity,
        customer: { id: userId } as UserEntity,
        ride:     { id: lockedRide.id } as RideEntity,
      });
      await em.save(payment);

      const tickets = await this.issueTicket(em, userId, payment, quantity, lockedRide);

      // FIX: previously enqueued onto a Redis-backed BullMQ queue that has
      // been unreachable in production, so this always silently failed —
      // the ticket issuance still "succeeded" from the caller's point of
      // view, but no email ever went out. Now sent directly (no Redis
      // involved) and its real outcome is reported back as emailSent,
      // instead of the frontend unconditionally claiming success.
      const emailSent = await this.ticketEmail.sendTicketEmail(tickets.map((t) => t.id));

      this.notifications.enqueue({
        type:            NotificationType.TICKET_ISSUED,
        recipientUserId: userId,
        payload: { ticketId: tickets[0].id, displayId: tickets[0].displayId, count: tickets.length },
      });

      return { tickets, paymentId: payment.id, emailSent };
    });
  }

  /**
   * Operator-only: issue a real ticket for one of *their own* rides without
   * any payment step at all — for testing that QR generation and gate
   * scanning actually work end-to-end, without needing a real paying
   * customer or Razorpay wired up.
   *
   * Reuses the exact same seat-locking + issuance path as a normal free
   * booking (`issueFreeTicket`), just with `totalAmount` forced to 0 (so it
   * never shows up as revenue) and an ownership check first (an operator
   * can only issue test tickets for rides under their own fairs).
   */
  async issueTestTicket(userId: string, dto: IssueTestTicketDto) {
    const operator = await this.operators.findOne({ where: { owner: { id: userId } } });
    if (!operator) throw new ForbiddenException("No operator account found for this user");

    const ride = await this.rides.findOne({
      where: { id: dto.rideId },
      relations: ["fair", "fair.operator"],
    });
    if (!ride) throw new NotFoundException("Ride not found");
    if (ride.fair?.operator?.id !== operator.id) {
      throw new ForbiddenException("This ride doesn't belong to your account");
    }

    // Default: issue to the operator's own account — the fastest path to a
    // scannable QR for testing. An email only needs to be passed if the
    // ticket should be attached to a specific existing customer instead.
    let targetUserId = userId;
    if (dto.customerEmail) {
      const customer = await this.users.findOne({ where: { email: dto.customerEmail } });
      if (!customer) {
        throw new NotFoundException(
          "No account found with that email. Leave it blank to issue the test ticket to your own account instead.",
        );
      }
      targetUserId = customer.id;
    }

    return this.issueFreeTicket(targetUserId, ride, dto.quantity ?? 1, 0);
  }

  /** Step 2: Verify Razorpay signature and issue the ticket (payments-mode only) */
  async verifyAndIssueTicket(userId: string, dto: VerifyPaymentDto) {
    if (!this.paymentsEnabled) {
      throw new BadRequestException("Payments are not enabled on this deployment yet.");
    }
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = dto;

    // Signature verification
    const expectedSig = crypto
      .createHmac("sha256", this.config.get("app.razorpay.keySecret", ""))
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest("hex");

    if (expectedSig !== razorpaySignature) {
      throw new BadRequestException("Payment verification failed — invalid signature");
    }

    // NOTE on isolation: Postgres default is READ COMMITTED. We do NOT rely on
    // raising the transaction isolation level here — instead we take a
    // pessimistic row lock (`SELECT ... FOR UPDATE`) on the specific ride row.
    // This serializes concurrent bookings for the *same ride* without paying
    // the cost (and retry/serialization-failure handling) of SERIALIZABLE
    // across the whole transaction. This is the standard, low-risk pattern
    // for "don't oversell N seats" problems.
    return this.db.transaction("READ COMMITTED", async (em) => {
      const payment = await em.getRepository(PaymentEntity).findOne({
        where: { razorpayOrderId, customer: { id: userId } },
        relations: ["ride"],
      });
      if (!payment) throw new NotFoundException("Payment record not found");
      if (payment.status === PaymentStatus.PAID) {
        throw new BadRequestException("Payment already processed");
      }
      if (!payment.ride) {
        throw new BadRequestException("Payment is missing ride reference");
      }

      // ── Capacity lock: block every other transaction trying to book the
      // same ride until this one commits/rolls back. Prevents the classic
      // double-booking race where two requests both read "2 seats left"
      // and both insert a ticket.
      const ride = await em.getRepository(RideEntity)
        .createQueryBuilder("ride")
        .leftJoinAndSelect("ride.fair", "fair")
        .setLock("pessimistic_write")
        .where("ride.id = :id", { id: payment.ride.id })
        .getOne();

      if (!ride) throw new NotFoundException("Ride not found");

      // Same seats-not-rows fix as issueFreeTicket() above — kept identical
      // so free and future paid bookings enforce capacity the same way.
      const { total } = await em.getRepository(TicketEntity)
        .createQueryBuilder("t")
        .select("COALESCE(SUM(t.quantity), 0)", "total")
        .where("t.rideId = :rideId", { rideId: ride.id })
        .andWhere("t.ticketStatus = :status", { status: TicketStatus.VALID })
        .getRawOne();
      const bookedCount = Number(total);

      if (bookedCount + payment.quantity > ride.capacity) {
        // Refund/void path left for the payments module — for now we fail
        // fast so no ticket is issued beyond capacity.
        payment.status = PaymentStatus.FAILED;
        await em.save(payment);
        this.notifications.enqueue({
          type:    NotificationType.RIDE_SOLD_OUT,
          fairId:  ride.fair?.id,
          payload: { rideId: ride.id, rideName: ride.name },
        });
        throw new BadRequestException(
          "This ride just sold out. Your payment will be refunded.",
        );
      }

      // Mark payment as paid
      payment.status             = PaymentStatus.PAID;
      payment.razorpayPaymentId  = razorpayPaymentId;
      payment.razorpaySignature  = razorpaySignature;
      await em.save(payment);

      const tickets = await this.issueTicket(em, userId, payment, payment.quantity, ride);

      // Sent directly (no Redis/queue involved) — see the free-ticket path
      // above for why. Bounded to a few seconds so a slow SMTP server can
      // never hang a real, already-paid booking's response either.
      const emailSent = await this.ticketEmail.sendTicketEmail(tickets.map((t) => t.id));

      // In-app + future push/SMS notification — non-blocking, outside this
      // DB transaction's concern. Eventual consistency: the customer sees
      // "Ticket Issued" pop up a moment after the response.
      this.notifications.enqueue({
        type:             NotificationType.TICKET_ISSUED,
        recipientUserId:  userId,
        payload: {
          ticketId:  tickets[0].id,
          displayId: tickets[0].displayId,
          count:     tickets.length,
        },
      });

      return { tickets, paymentId: payment.id, emailSent };
    });
  }

  /**
   * Razorpay webhook handler.
   * Handles payment.captured and payment.failed events.
   * Webhook is the source of truth for payment status — not just the frontend callback.
   */
  async handleWebhook(
    rawBody: Buffer,
    signature: string,
  ) {
    if (!this.paymentsEnabled) {
      throw new BadRequestException("Payments are not enabled on this deployment yet.");
    }
    const secret = this.config.get("app.razorpay.webhookSecret", "");

    // Verify webhook signature
    const expectedSig = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");

    if (expectedSig !== signature) {
      throw new BadRequestException("Invalid webhook signature");
    }

    const event = JSON.parse(rawBody.toString());
    this.logger.log(`Razorpay webhook: ${event.event}`);

    if (event.event === "payment.captured") {
      const p = event.payload.payment.entity;
      const payment = await this.payments.findOne({
        where: { razorpayOrderId: p.order_id },
      });
      if (payment && payment.status !== PaymentStatus.PAID) {
        payment.status            = PaymentStatus.PAID;
        payment.razorpayPaymentId = p.id;
        payment.gatewayResponse   = p;
        await this.payments.save(payment);
      }
    }

    if (event.event === "payment.failed") {
      const p = event.payload.payment.entity;
      const payment = await this.payments.findOne({
        where: { razorpayOrderId: p.order_id },
      });
      if (payment) {
        payment.status          = PaymentStatus.FAILED;
        payment.gatewayResponse = p;
        await this.payments.save(payment);
      }
    }

    return { received: true };
  }

  /**
   * Issues `quantity` individually-scannable tickets — one row, one QR
   * token, per person — instead of a single row carrying a `quantity`
   * field. That older model meant a group of 5 shared exactly one QR code,
   * so the gate could only ever redeem "all 5 at once" in a single scan,
   * and only one QR image existed to show/email in the first place.
   * Returns an array; every caller now handles N tickets, not one.
   */
  private async issueTicket(
    em: any,
    userId: string,
    payment: PaymentEntity,
    quantity: number,
    ride: RideEntity,
  ) {
    if (!ride.fair?.startDate) {
      throw new BadRequestException("This ride's fair has no event date set — cannot issue ticket.");
    }
    const eventDate = ride.fair.startDate;
    const ticketRepo = em.getRepository(TicketEntity);
    const savedIds: string[] = [];

    for (let i = 0; i < quantity; i++) {
      // FIX: displayId used to be `MT${Date.now().toString().slice(-5)}`
      // computed once per booking — fine when only one row was ever
      // created per purchase. Generating several rows in a tight loop can
      // easily land in the same millisecond, which would produce the exact
      // same displayId twice and fail on the column's unique constraint.
      // Offsetting Date.now() by the loop index keeps the same format
      // while guaranteeing every ticket in this batch gets a distinct value.
      const displayId = `MT${(Date.now() + i).toString().slice(-5)}`;
      const qrToken   = uuidv4(); // opaque — no user data in QR

      const ticket = ticketRepo.create({
        displayId,
        qrToken,
        quantity: 1, // each row now represents exactly one admission
        pricePerPerson: ride.pricePerPerson,
        totalAmount:    ride.pricePerPerson, // this ticket's own share, not the whole payment's total
        paymentMethod:  payment.method,
        paymentStatus:  PaymentStatus.PAID,
        ticketStatus:   TicketStatus.VALID,
        eventDate,
        customer:      { id: userId } as UserEntity,
        ride:          { id: ride.id } as RideEntity,
        fair:          { id: ride.fair.id } as FairEntity,
        payment,
      });
      const saved = await ticketRepo.save(ticket);
      savedIds.push(saved.id);
    }

    // FIX: this used to return the just-saved entity as-is, which only had
    // `{ id }` stubs for `customer`/`ride`/`fair` (exactly what was assigned
    // above) — none of the flat display fields (`rideName`, `fairName`,
    // `customerName`, etc.) the frontend `Ticket` type expects. That's what
    // made the "just booked" ticket card show blank right after checkout.
    // Reload with the relations loaded and route through the same
    // `toTicketDto` every other ticket-reading endpoint uses, so this
    // response is never a special, differently-shaped case.
    const fullTickets = await ticketRepo.find({
      where:     { id: In(savedIds) },
      relations: ["ride", "fair", "customer"],
    });
    // .find() with an IN(...) clause doesn't preserve insertion order —
    // re-sort to match savedIds so "ticket 1 of 5" stays stable across the
    // API response, the confirmation screen, and the email.
    const byId: Record<string, any> = {};
    for (const t of fullTickets) byId[t.id] = t;
    return savedIds.map((id) => toTicketDto(byId[id]));
  }
}

// ── Controller ────────────────────────────────────────────────────────────────

@ApiTags("bookings")
@Controller({ path: "bookings", version: "1" })
export class BookingsController {
  constructor(private readonly svc: BookingsService) {}

  @Post()
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: "Book a ride. Pass 'Idempotency-Key: <uuid>' header to safely retry without duplicate tickets.",
  })
  create(
    @Body() dto: CreateBookingDto,
    @CurrentUser("sub") userId: string,
    @Headers("idempotency-key") idempotencyKey?: string,
  ) {
    return this.svc.createBooking(userId, dto, idempotencyKey);
  }

  @Post("verify")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "[Payments mode only] Verify Razorpay payment and issue ticket" })
  verify(@Body() dto: VerifyPaymentDto, @CurrentUser("sub") userId: string) {
    return this.svc.verifyAndIssueTicket(userId, dto);
  }

  @Post("operator/issue-test-ticket")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.OPERATOR_OWNER, UserRole.OPERATOR_MANAGER)
  @ApiOperation({
    summary: "Operator-only: issue a ticket without payment, for QR/scanner testing",
  })
  issueTestTicket(@Body() dto: IssueTestTicketDto, @CurrentUser("sub") userId: string) {
    return this.svc.issueTestTicket(userId, dto);
  }

  @Post("webhook")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "[Payments mode only] Razorpay webhook endpoint (no auth)" })
  webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers("x-razorpay-signature") sig: string,
  ) {
    return this.svc.handleWebhook(req.rawBody!, sig);
  }
}

// ── Module ────────────────────────────────────────────────────────────────────

@Module({
  imports: [
    TypeOrmModule.forFeature([TicketEntity, PaymentEntity, RideEntity, FairEntity, UserEntity, OperatorEntity]),
    NotificationsModule,
    EmailModule,
  ],
  controllers: [BookingsController],
  providers:   [BookingsService],
  exports:     [BookingsService],
})
export class BookingsModule {}
