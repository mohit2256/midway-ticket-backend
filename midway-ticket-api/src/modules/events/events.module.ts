// ═══════════════════════════════════════════════════════════════════════════════
// EVENTS MODULE
// Standalone events an operator hosts directly — NOT tied to a Fair, NOT
// broken into Rides. e.g. a college auditorium show, a single-venue gathering.
//
// The key difference from Ride bookings: `requiresPayment` is a per-event
// choice made by the operator, not a global deployment flag. When false, no
// payment method is ever accepted or expected for this event's bookings —
// the ticket is issued immediately, free, straight to QR.
// ═══════════════════════════════════════════════════════════════════════════════

import {
  Injectable, NotFoundException, BadRequestException, ForbiddenException, Logger,
} from "@nestjs/common";
import { InjectRepository, InjectDataSource } from "@nestjs/typeorm";
import { Repository, DataSource } from "typeorm";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { BullModule } from "@nestjs/bullmq";
import { ConfigService } from "@nestjs/config";
import Razorpay from "razorpay";
import * as crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import {
  IsString, IsDateString, IsInt, Min, Max, IsBoolean, IsEnum, IsEmail, IsOptional,
} from "class-validator";
import { Type } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  Controller, Get, Post, Patch, Body, Param, Query, UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import {
  EventEntity, EventStatus, OperatorEntity, UserEntity, PaymentEntity,
  TicketEntity, TicketStatus, PaymentStatus, PaymentMethod, UserRole,
  NotificationType,
} from "../entities";
import { JwtAuthGuard, RolesGuard, Roles, CurrentUser } from "../../common/guards/auth.guards";
import { NotificationsService } from "../notifications/notifications.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { toTicketDto } from "../tickets/tickets.module";

// ── DTOs ──────────────────────────────────────────────────────────────────────

class CreateEventDto {
  @ApiProperty()        @IsString()      name:        string;
  @ApiProperty()        @IsString()      venue:       string;
  @ApiProperty()        @IsString()      city:        string;
  @ApiProperty()        @IsDateString()  eventDate:   string;
  @ApiProperty()        @IsInt() @Min(1) @Type(() => Number) capacity: number;
  @ApiPropertyOptional({ default: 0 })
  @IsOptional() @IsInt() @Min(0) @Type(() => Number)
  pricePerTicket?: number;
  // The whole point of Events: operator decides, per event, whether a
  // payment is even collected. Defaults to false (free) — an operator has
  // to deliberately opt IN to payment, never the other way around.
  @ApiPropertyOptional({ default: false })
  @IsOptional() @IsBoolean() @Type(() => Boolean)
  requiresPayment?: boolean;
  @ApiPropertyOptional() @IsString() @IsOptional() description?:   string;
  @ApiPropertyOptional() @IsString() @IsOptional() coverGradient?: string;
  @ApiPropertyOptional() @IsString() @IsOptional() emoji?:         string;
}

class UpdateEventDto {
  @ApiPropertyOptional() @IsString()     @IsOptional() name?:            string;
  @ApiPropertyOptional() @IsString()     @IsOptional() venue?:           string;
  @ApiPropertyOptional() @IsDateString() @IsOptional() eventDate?:       string;
  @ApiPropertyOptional() @IsInt() @Min(1) @Type(() => Number) @IsOptional() capacity?: number;
  @ApiPropertyOptional() @IsInt() @Min(0) @Type(() => Number) @IsOptional() pricePerTicket?: number;
  @ApiPropertyOptional() @IsBoolean() @Type(() => Boolean)    @IsOptional() requiresPayment?: boolean;
  @ApiPropertyOptional() @IsEnum(EventStatus) @IsOptional()   status?: EventStatus;
}

class BookEventDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional() @IsInt() @Min(1) @Max(10) @Type(() => Number)
  quantity?: number;
  @ApiPropertyOptional() @IsOptional() @IsEmail() customerEmail?: string;
  // Only meaningful when the event's own `requiresPayment` is true. Ignored
  // entirely for a free event — never validated as "required" here, on
  // purpose, so a free event's booking call can omit it completely.
  @ApiPropertyOptional() @IsOptional() @IsString() paymentMethod?: string;
}

class VerifyEventPaymentDto {
  @ApiProperty() @IsString() razorpayOrderId:   string;
  @ApiProperty() @IsString() razorpayPaymentId: string;
  @ApiProperty() @IsString() razorpaySignature: string;
}

class IssueTestEventTicketDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional() @IsInt() @Min(1) @Max(10) @Type(() => Number)
  quantity?: number;
  @ApiPropertyOptional() @IsOptional() @IsEmail() customerEmail?: string;
}

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);
  private readonly razorpay: Razorpay | null;
  private readonly paymentsEnabled: boolean;

  constructor(
    @InjectRepository(EventEntity)    private events:    Repository<EventEntity>,
    @InjectRepository(OperatorEntity) private operators: Repository<OperatorEntity>,
    @InjectRepository(UserEntity)     private users:     Repository<UserEntity>,
    @InjectRepository(PaymentEntity)  private payments:  Repository<PaymentEntity>,
    @InjectRepository(TicketEntity)   private tickets:   Repository<TicketEntity>,
    @InjectDataSource()               private db:        DataSource,
    @InjectQueue("email")             private emailQ:    Queue,
    private readonly config:          ConfigService,
    private readonly notifications:   NotificationsService,
  ) {
    this.paymentsEnabled = this.config.get("app.paymentsEnabled", false);
    this.razorpay = this.paymentsEnabled
      ? new Razorpay({
          key_id:     this.config.get("app.razorpay.keyId",     "rzp_test_key"),
          key_secret: this.config.get("app.razorpay.keySecret", "rzp_test_secret"),
        })
      : null;
  }

  async resolveOperator(userId: string): Promise<string> {
    const operator = await this.operators.findOne({ where: { owner: { id: userId } } });
    if (!operator) throw new ForbiddenException("No operator account found for this user");
    return operator.id;
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  async findAll(city?: string) {
    const qb = this.events
      .createQueryBuilder("e")
      .where("e.status = :active", { active: EventStatus.ACTIVE });
    if (city) qb.andWhere("LOWER(e.city) LIKE :city", { city: `%${city.toLowerCase()}%` });
    return qb.orderBy("e.eventDate", "ASC").getMany();
  }

  async findByOperator(operatorId: string) {
    return this.events.find({
      where: { operator: { id: operatorId } },
      order: { createdAt: "DESC" },
    });
  }

  async findOne(id: string) {
    const event = await this.events.findOne({ where: { id } });
    if (!event) throw new NotFoundException("Event not found");
    return event;
  }

  async create(dto: CreateEventDto, userId: string) {
    const operator = await this.operators.findOne({ where: { owner: { id: userId } } });
    if (!operator) throw new ForbiddenException("No operator account found");
    const event = this.events.create({
      ...dto,
      pricePerTicket:  dto.pricePerTicket ?? 0,
      requiresPayment: dto.requiresPayment ?? false,
      // FIX: the entity column defaults status to DRAFT, and there was no
      // publish action anywhere — no UI button, no separate endpoint — to
      // ever move an event out of DRAFT afterwards. findAll() (public
      // listing) only returns status = ACTIVE, so every event created
      // through this form was permanently invisible to customers from the
      // moment it was created, with no way to fix it after the fact.
      // Fairs and Rides elsewhere in this app go live immediately on
      // creation with no moderation step, so Events does the same here for
      // consistency — an operator finishing this form expects it to be
      // live, the same way finishing "New Ride" makes a ride bookable.
      status: EventStatus.ACTIVE,
      operator,
    });
    return this.events.save(event);
  }

  async update(id: string, dto: UpdateEventDto, userId: string) {
    const event = await this.events.findOne({
      where: { id },
      relations: ["operator", "operator.owner"],
    });
    if (!event) throw new NotFoundException("Event not found");
    if (event.operator.owner.id !== userId) throw new ForbiddenException();
    Object.assign(event, dto);
    return this.events.save(event);
  }

  // ── Booking (customer-facing) ────────────────────────────────────────────

  async book(eventId: string, userId: string, dto: BookEventDto) {
    const event = await this.events.findOne({ where: { id: eventId } });
    if (!event) throw new NotFoundException("Event not found");
    if (event.status !== EventStatus.ACTIVE) {
      throw new BadRequestException("This event isn't open for booking right now.");
    }

    const quantity = dto.quantity ?? 1;
    const totalAmount = Number(event.pricePerTicket) * quantity;

    // The deciding factor is the EVENT's own flag, not the global payments
    // toggle — an operator who set requiresPayment=false gets a free,
    // no-payment-option booking regardless of what's enabled deployment-wide.
    // (If the deployment-wide flag is off entirely, everything is free —
    // same launch-mode behaviour as ride bookings.)
    if (!event.requiresPayment || !this.paymentsEnabled) {
      return this.issueFreeEventTicket(userId, event, quantity, event.requiresPayment ? totalAmount : 0);
    }

    const order = await this.razorpay!.orders.create({
      amount:   totalAmount * 100,
      currency: "INR",
      receipt:  `mte_${Date.now()}`,
    }).catch((err) => {
      this.logger.error("Razorpay order creation failed", err);
      throw new BadRequestException("Payment gateway error. Please try again.");
    });

    const payment = this.payments.create({
      razorpayOrderId: order.id,
      amount:          totalAmount,
      currency:        "INR",
      status:          PaymentStatus.PENDING,
      method:          (dto.paymentMethod as PaymentMethod) ?? undefined,
      quantity,
      customer: { id: userId } as UserEntity,
      event,
    });
    await this.payments.save(payment);

    return {
      orderId:     order.id,
      amount:      totalAmount,
      currency:    "INR",
      paymentId:   payment.id,
      eventDetails: { name: event.name, venue: event.venue, quantity, pricePerTicket: event.pricePerTicket },
      razorpayKeyId: this.config.get("app.razorpay.keyId"),
    };
  }

  private async issueFreeEventTicket(
    userId: string,
    event: EventEntity,
    quantity: number,
    totalAmount: number,
  ) {
    return this.db.transaction("READ COMMITTED", async (em) => {
      const lockedEvent = await em.getRepository(EventEntity)
        .createQueryBuilder("event")
        .setLock("pessimistic_write")
        .where("event.id = :id", { id: event.id })
        .getOne();
      if (!lockedEvent) throw new NotFoundException("Event not found");

      const { total } = await em.getRepository(TicketEntity)
        .createQueryBuilder("t")
        .select("COALESCE(SUM(t.quantity), 0)", "total")
        .where("t.eventId = :eventId", { eventId: lockedEvent.id })
        .andWhere("t.ticketStatus = :status", { status: TicketStatus.VALID })
        .getRawOne();
      const bookedCount = Number(total);

      if (bookedCount + quantity > lockedEvent.capacity) {
        throw new BadRequestException("This event just sold out.");
      }

      const payment = em.getRepository(PaymentEntity).create({
        amount:   totalAmount,
        currency: "INR",
        status:   PaymentStatus.PAID,
        method:   PaymentMethod.FREE,
        quantity,
        customer: { id: userId } as UserEntity,
        event:    { id: lockedEvent.id } as EventEntity,
      });
      await em.save(payment);

      const ticket = await this.issueEventTicket(em, userId, payment, quantity, lockedEvent);

      await this.emailQ.add("send-ticket", {
        customerId: userId,
        ticketId:   ticket.id,
        displayId:  ticket.displayId,
      }).catch(() => {/* email failure should not fail the booking */});

      await this.notifications.enqueue({
        type:            NotificationType.TICKET_ISSUED,
        recipientUserId: userId,
        payload: { ticketId: ticket.id, displayId: ticket.displayId },
      });

      return { ticket, paymentId: payment.id };
    });
  }

  async verifyAndIssueTicket(userId: string, dto: VerifyEventPaymentDto) {
    if (!this.paymentsEnabled) {
      throw new BadRequestException("Payments are not enabled on this deployment yet.");
    }
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = dto;
    const expectedSig = crypto
      .createHmac("sha256", this.config.get("app.razorpay.keySecret", ""))
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest("hex");
    if (expectedSig !== razorpaySignature) {
      throw new BadRequestException("Payment verification failed — invalid signature");
    }

    return this.db.transaction("READ COMMITTED", async (em) => {
      const payment = await em.getRepository(PaymentEntity).findOne({
        where: { razorpayOrderId, customer: { id: userId } },
        relations: ["event"],
      });
      if (!payment) throw new NotFoundException("Payment record not found");
      if (payment.status === PaymentStatus.PAID) throw new BadRequestException("Payment already processed");
      if (!payment.event) throw new BadRequestException("Payment is missing event reference");

      const event = await em.getRepository(EventEntity)
        .createQueryBuilder("event")
        .setLock("pessimistic_write")
        .where("event.id = :id", { id: payment.event.id })
        .getOne();
      if (!event) throw new NotFoundException("Event not found");

      const { total } = await em.getRepository(TicketEntity)
        .createQueryBuilder("t")
        .select("COALESCE(SUM(t.quantity), 0)", "total")
        .where("t.eventId = :eventId", { eventId: event.id })
        .andWhere("t.ticketStatus = :status", { status: TicketStatus.VALID })
        .getRawOne();
      const bookedCount = Number(total);

      if (bookedCount + payment.quantity > event.capacity) {
        payment.status = PaymentStatus.FAILED;
        await em.save(payment);
        throw new BadRequestException("This event just sold out. Your payment will be refunded.");
      }

      payment.status            = PaymentStatus.PAID;
      payment.razorpayPaymentId = razorpayPaymentId;
      payment.razorpaySignature = razorpaySignature;
      await em.save(payment);

      const ticket = await this.issueEventTicket(em, userId, payment, payment.quantity, event);

      await this.emailQ.add("send-ticket", {
        customerId: userId,
        ticketId:   ticket.id,
        displayId:  ticket.displayId,
      }).catch(() => {/* non-critical */});

      await this.notifications.enqueue({
        type:            NotificationType.TICKET_ISSUED,
        recipientUserId: userId,
        payload: { ticketId: ticket.id, displayId: ticket.displayId },
      });

      return { ticket, paymentId: payment.id };
    });
  }

  private async issueEventTicket(
    em: any,
    userId: string,
    payment: PaymentEntity,
    quantity: number,
    event: EventEntity,
  ) {
    const displayId = `MT${Date.now().toString().slice(-5)}`;
    const qrToken   = uuidv4();

    const ticket = em.getRepository(TicketEntity).create({
      displayId,
      qrToken,
      quantity,
      pricePerPerson: event.pricePerTicket,
      totalAmount:    payment.amount,
      paymentMethod:  payment.method,
      paymentStatus:  PaymentStatus.PAID,
      ticketStatus:   TicketStatus.VALID,
      eventDate:      event.eventDate,
      customer:       { id: userId } as UserEntity,
      event:          { id: event.id } as EventEntity,
      payment,
    });
    const saved = await em.getRepository(TicketEntity).save(ticket);

    const full = await em.getRepository(TicketEntity).findOne({
      where:     { id: saved.id },
      relations: ["event", "customer"],
    });
    return toTicketDto(full!);
  }

  // ── Operator: issue a ticket without payment (QR/scanner testing) ────────

  async issueTestTicket(userId: string, eventId: string, dto: IssueTestEventTicketDto) {
    const operator = await this.operators.findOne({ where: { owner: { id: userId } } });
    if (!operator) throw new ForbiddenException("No operator account found for this user");

    const event = await this.events.findOne({
      where: { id: eventId },
      relations: ["operator"],
    });
    if (!event) throw new NotFoundException("Event not found");
    if (event.operator?.id !== operator.id) {
      throw new ForbiddenException("This event doesn't belong to your account");
    }

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

    return this.issueFreeEventTicket(targetUserId, event, dto.quantity ?? 1, 0);
  }
}

// ── Controller ────────────────────────────────────────────────────────────────

@ApiTags("events")
@Controller({ path: "events", version: "1" })
export class EventsController {
  constructor(private readonly svc: EventsService) {}

  @Get()
  @ApiOperation({ summary: "List all active standalone events (public)" })
  findAll(@Query("city") city?: string) {
    return this.svc.findAll(city);
  }

  @Get("operator/mine")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.OPERATOR_OWNER, UserRole.OPERATOR_MANAGER)
  @ApiOperation({ summary: "List operator's own events" })
  async myEvents(@CurrentUser("sub") userId: string) {
    const operatorId = await this.svc.resolveOperator(userId);
    return this.svc.findByOperator(operatorId);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get event detail (public)" })
  findOne(@Param("id") id: string) {
    return this.svc.findOne(id);
  }

  @Post()
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.OPERATOR_OWNER, UserRole.OPERATOR_MANAGER)
  @ApiOperation({ summary: "Create a standalone event (operator)" })
  create(@Body() dto: CreateEventDto, @CurrentUser("sub") userId: string) {
    return this.svc.create(dto, userId);
  }

  @Patch(":id")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.OPERATOR_OWNER, UserRole.OPERATOR_MANAGER)
  @ApiOperation({ summary: "Update event, incl. toggling requiresPayment (operator)" })
  update(@Param("id") id: string, @Body() dto: UpdateEventDto, @CurrentUser("sub") userId: string) {
    return this.svc.update(id, dto, userId);
  }

  @Post(":id/book")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: "Book a ticket for this event. No payment method is accepted or required when the event's requiresPayment is false.",
  })
  book(@Param("id") id: string, @Body() dto: BookEventDto, @CurrentUser("sub") userId: string) {
    return this.svc.book(id, userId, dto);
  }

  @Post(":id/verify")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: "[Paid events only] Verify Razorpay payment and issue ticket" })
  verify(@Body() dto: VerifyEventPaymentDto, @CurrentUser("sub") userId: string) {
    return this.svc.verifyAndIssueTicket(userId, dto);
  }

  @Post(":id/issue-test-ticket")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.OPERATOR_OWNER, UserRole.OPERATOR_MANAGER)
  @ApiOperation({ summary: "Operator-only: issue a ticket without payment, for QR/scanner testing" })
  issueTestTicket(
    @Param("id") id: string,
    @Body() dto: IssueTestEventTicketDto,
    @CurrentUser("sub") userId: string,
  ) {
    return this.svc.issueTestTicket(userId, id, dto);
  }
}

// ── Module ────────────────────────────────────────────────────────────────────

@Module({
  imports: [
    TypeOrmModule.forFeature([EventEntity, OperatorEntity, UserEntity, PaymentEntity, TicketEntity]),
    BullModule.registerQueue({ name: "email" }),
    NotificationsModule,
  ],
  controllers: [EventsController],
  providers:   [EventsService],
  exports:     [EventsService],
})
export class EventsModule {}
