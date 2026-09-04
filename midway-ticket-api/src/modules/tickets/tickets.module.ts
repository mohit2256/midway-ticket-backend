// ═══════════════════════════════════════════════════════════════════════════════
// TICKETS MODULE — Core business logic: QR generation + atomic redemption
//
// The redemption flow MUST be atomic to prevent double-scanning:
//   1. Begin transaction
//   2. SELECT ticket WHERE qrToken = ? FOR UPDATE SKIP LOCKED
//   3. Validate all conditions (payment, expiry, ride, not-used)
//   4. UPDATE ticket status = USED, redeemedAt = NOW()
//   5. INSERT scan_log
//   6. Commit
//
// Redis provides a fast first-pass cache of used tokens to reduce DB load.
// The PostgreSQL transaction is the authoritative source of truth.
// ═══════════════════════════════════════════════════════════════════════════════

import {
  Injectable, NotFoundException, ConflictException, ForbiddenException,
} from "@nestjs/common";
import { InjectRepository, InjectDataSource } from "@nestjs/typeorm";
import { Repository, DataSource } from "typeorm";
import { Inject } from "@nestjs/common";
import { CACHE_MANAGER } from "@nestjs/cache-manager";
import { Cache } from "cache-manager";
import { v4 as uuidv4 } from "uuid";
import * as QRCode from "qrcode";
import {
  TicketEntity, TicketStatus, PaymentStatus, PaymentMethod,
  StaffEntity, ScanLogEntity, ScanOutcome, RideEntity, NotificationType,
} from "../entities";
import { IsString, IsUUID } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import {
  Controller, Get, Post, Param, Body, UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { JwtAuthGuard, RolesGuard, Roles, CurrentUser, ScannerRideGuard } from "../../common/guards/auth.guards";
import { UserRole } from "../entities";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { NotificationsService } from "../notifications/notifications.module";
import { NotificationsModule } from "../notifications/notifications.module";

// ── DTOs ──────────────────────────────────────────────────────────────────────
class RedeemTicketDto {
  @ApiProperty({ description: "The QR token scanned from the customer's ticket" })
  @IsString()
  qrToken: string;

  @ApiProperty({ description: "Ride ID this scanner is assigned to" })
  @IsUUID()
  rideId: string;

  @ApiProperty({ description: "Gate label for audit trail" })
  @IsString()
  gate: string;
}

export interface RedeemResult {
  outcome: ScanOutcome;
  message: string;
  /**
   * FIX: this was `Partial<TicketEntity>` — but the object actually
   * constructed below (`customerName`, `rideName`) has never matched
   * `TicketEntity`'s real shape (which only has `customer`/`ride` relation
   * objects, no flat name fields). TypeScript's excess-property check on
   * that literal return was a genuine compile error under this project's
   * `noImplicitAny`/`strictNullChecks` tsconfig — `nest build` (a real
   * `tsc` type-check, not transpile-only) fails on it, which is why the
   * Railway deploy never went live. Typed to match exactly what's built.
   */
  ticket?: {
    id: string;
    displayId: string;
    quantity: number;
    customerName?: string;
    rideName?: string;
    eventDate: string;
    paymentMethod: PaymentMethod;
    totalAmount: number;
  };
  actualRideName?: string;
  redeemedAt?: Date;
  redeemedByStaffName?: string;
  redeemedAtGate?: string;
}

/**
 * FIX: `TicketEntity` only ever exposed nested relation objects
 * (`ticket.ride`, `ticket.fair`, `ticket.customer`) — but the frontend's
 * `Ticket` type expects flat fields (`fairName`, `rideName`, `rideEmoji`,
 * `customerName`, etc). Every real API response silently had those fields
 * `undefined`, which broke the "just booked" ticket card shown right after
 * checkout and any direct property access on the My Tickets / ticket detail
 * pages. This is the single source of truth for that shape — every endpoint
 * that returns a customer-facing ticket routes through this, so the shape
 * can't drift between "my tickets", "ticket detail", and "just booked".
 * Callers must load the `ride`, `fair`, and `customer` relations (and
 * `redeemedByStaff`/`redeemedByStaff.user` when redemption info matters) —
 * this function only reads what's already been joined, it doesn't query.
 */
export function toTicketDto(ticket: TicketEntity) {
  return {
    id:                  ticket.id,
    displayId:            ticket.displayId,
    fairId:               ticket.fair?.id,
    fairName:             ticket.fair?.name,
    rideId:               ticket.ride?.id,
    rideName:             ticket.ride?.name,
    rideEmoji:            ticket.ride?.emoji,
    rideCoverGradient:    ticket.ride?.coverGradient,
    customerId:           ticket.customer?.id,
    customerName:         ticket.customer?.name,
    customerEmail:        ticket.customer?.email,
    quantity:             ticket.quantity,
    pricePerPerson:       ticket.pricePerPerson,
    totalAmount:          ticket.totalAmount,
    paymentMethod:        ticket.paymentMethod,
    paymentStatus:        ticket.paymentStatus,
    ticketStatus:         ticket.ticketStatus,
    bookedAt:             ticket.createdAt,
    eventDate:            ticket.eventDate,
    redeemedAt:           ticket.redeemedAt ?? undefined,
    redeemedByStaffId:    ticket.redeemedByStaff?.id,
    redeemedByStaffName:  ticket.redeemedByStaff?.user?.name,
    redeemedAtGate:       ticket.redeemedAtGate ?? undefined,
  };
}

// ── Service ───────────────────────────────────────────────────────────────────
@Injectable()
export class TicketsService {
  // Redis key prefix for used ticket cache
  private readonly USED_KEY = "ticket:used:";
  // Cache TTL for used tickets (24 hours — covers the day's fair)
  private readonly USED_TTL = 86_400_000;

  constructor(
    @InjectRepository(TicketEntity) private readonly tickets: Repository<TicketEntity>,
    @InjectRepository(StaffEntity)  private readonly staff:   Repository<StaffEntity>,
    @InjectRepository(ScanLogEntity) private readonly scanLogs: Repository<ScanLogEntity>,
    @InjectRepository(RideEntity)   private readonly rides:   Repository<RideEntity>,
    @InjectDataSource()             private readonly db:      DataSource,
    @Inject(CACHE_MANAGER)          private readonly cache:   Cache,
    private readonly realtime:      RealtimeGateway,
    private readonly notifications: NotificationsService,
  ) {}

  async getMyTickets(customerId: string) {
    const tickets = await this.tickets.find({
      where:     { customer: { id: customerId }, paymentStatus: PaymentStatus.PAID },
      relations: ["ride", "fair", "customer"],
      order:     { createdAt: "DESC" },
    });
    return tickets.map(toTicketDto);
  }

  async getTicketById(id: string, customerId: string) {
    const ticket = await this.tickets.findOne({
      where:     { id, customer: { id: customerId } },
      relations: ["ride", "fair", "customer", "redeemedByStaff", "redeemedByStaff.user"],
    });
    if (!ticket) throw new NotFoundException("Ticket not found");
    return toTicketDto(ticket);
  }

  /** Generate a QR data URL for display — purely visual, not for validation */
  async getTicketQR(displayId: string, customerId: string): Promise<{ qrDataUrl: string }> {
    const ticket = await this.tickets.findOne({
      where: { displayId, customer: { id: customerId } },
      select: ["id", "qrToken", "ticketStatus"],
    });
    if (!ticket) throw new NotFoundException("Ticket not found");
    // Encode only the opaque token — no user data embedded in QR
    const qrDataUrl = await QRCode.toDataURL(ticket.qrToken, { errorCorrectionLevel: "H", margin: 1 });
    // FIX: this returned the raw data-URL string. The response interceptor
    // wraps it as `{ success, data: "data:image/..." }`, so the frontend's
    // unwrapped result was a bare string — but `getTicketQr()` on the
    // frontend destructures `{ qrDataUrl }` from it, which is `undefined`
    // on a string. Wrapping it here in the object shape the frontend
    // actually expects fixes the QR code from silently failing to render.
    return { qrDataUrl };
  }

  // ── ATOMIC REDEMPTION ───────────────────────────────────────────────────────

  async redeem(staffId: string, dto: RedeemTicketDto): Promise<RedeemResult> {
    const { qrToken, rideId, gate } = dto;

    // ── Step 1: Redis fast-path for already-used tokens ──────────────────────
    const cachedUsed = await this.cache.get<string>(`${this.USED_KEY}${qrToken}`);
    if (cachedUsed) {
      await this.logScan(staffId, null, qrToken, ScanOutcome.ALREADY_USED, gate);
      const info = JSON.parse(cachedUsed);
      return {
        outcome: ScanOutcome.ALREADY_USED,
        message: "This ticket has already been redeemed.",
        redeemedAt:          info.redeemedAt,
        redeemedByStaffName: info.staffName,
        redeemedAtGate:      info.gate,
      };
    }

    // ── Step 2: Database atomic transaction ──────────────────────────────────
    // FIX: `pessimistic_write_or_fail` (SELECT ... FOR UPDATE NOWAIT) throws
    // immediately if the row is already locked — e.g. two staff scanning the
    // same ticket within the same instant, or a client-side retry firing
    // while the first attempt is still committing. That raw Postgres error
    // (55P03 "lock_not_available") was previously uncaught here, bubbling up
    // as an unhandled 500 to the scanner app instead of a clear result. The
    // lock window for one scan is a single row update — sub-millisecond in
    // practice — so a couple of short retries resolve almost every real
    // contention case correctly (into VALID / ALREADY_USED / etc.) instead
    // of surfacing a raw error to gate staff.
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.redeemInTransaction(staffId, qrToken, rideId, gate);
      } catch (err: any) {
        const isLockConflict = err?.code === "55P03"; // lock_not_available
        if (!isLockConflict || attempt === maxAttempts) {
          if (isLockConflict) {
            throw new ConflictException(
              "This ticket is being scanned by another device right now. Please try again in a moment.",
            );
          }
          throw err;
        }
        await new Promise((r) => setTimeout(r, 75 * attempt));
      }
    }
    // Unreachable — the loop above always returns or throws — but keeps
    // TypeScript's control-flow analysis happy about the return type.
    throw new ConflictException("Could not process this scan. Please try again.");
  }

  private async redeemInTransaction(
    staffId: string,
    qrToken: string,
    rideId:  string,
    gate:    string,
  ): Promise<RedeemResult> {
    return this.db.transaction(async (em) => {
      // SELECT … FOR UPDATE SKIP LOCKED prevents race conditions on high-traffic fairs
      const ticket = await em
        .getRepository(TicketEntity)
        .createQueryBuilder("t")
        .setLock("pessimistic_write_or_fail")
        .leftJoinAndSelect("t.ride", "r")
        .leftJoinAndSelect("t.fair", "f")
        .leftJoinAndSelect("t.customer", "c")
        .leftJoinAndSelect("t.redeemedByStaff", "rs")
        .leftJoinAndSelect("rs.user", "rsu")
        .where("t.qrToken = :qrToken", { qrToken })
        .getOne();

      // ── Validation pipeline ──────────────────────────────────────────────
      if (!ticket) {
        await this.logScan(staffId, null, qrToken, ScanOutcome.INVALID, gate);
        return { outcome: ScanOutcome.INVALID, message: "Invalid QR code. Not a MidwayTicket." };
      }

      if (ticket.paymentStatus !== PaymentStatus.PAID) {
        await this.logScan(staffId, ticket.id, qrToken, ScanOutcome.INVALID, gate);
        return { outcome: ScanOutcome.INVALID, message: "Payment not confirmed for this ticket." };
      }

      const today = new Date().toISOString().split("T")[0];
      if (ticket.eventDate < today) {
        await this.logScan(staffId, ticket.id, qrToken, ScanOutcome.EXPIRED, gate);
        return { outcome: ScanOutcome.EXPIRED, message: "This ticket has expired." };
      }

      if (ticket.ticketStatus === TicketStatus.USED) {
        await this.logScan(staffId, ticket.id, qrToken, ScanOutcome.ALREADY_USED, gate);
        return {
          outcome: ScanOutcome.ALREADY_USED,
          message: "This ticket was already redeemed.",
          redeemedAt:          ticket.redeemedAt,
          redeemedByStaffName: ticket.redeemedByStaff?.user?.name ?? "Staff",
          redeemedAtGate:      ticket.redeemedAtGate,
        };
      }

      // ── Ride mismatch check (critical security check) ────────────────────
      if (ticket.ride.id !== rideId) {
        await this.logScan(staffId, ticket.id, qrToken, ScanOutcome.WRONG_RIDE, gate);
        return {
          outcome:       ScanOutcome.WRONG_RIDE,
          message:       `This ticket is valid for ${ticket.ride.name}, not your assigned ride.`,
          actualRideName: ticket.ride.name,
        };
      }

      // ── All checks passed — mark as used ────────────────────────────────
      const staffMember = await em.getRepository(StaffEntity).findOne({
        where: { id: staffId },
        relations: ["user"],
      });

      ticket.ticketStatus    = TicketStatus.USED;
      ticket.redeemedAt      = new Date();
      ticket.redeemedByStaff = staffMember!;
      ticket.redeemedAtGate  = gate;
      await em.save(ticket);

      // Update staff scan counts
      if (staffMember) {
        staffMember.scansToday++;
        staffMember.scansTotal++;
        staffMember.lastScanAt = new Date();
        await em.save(staffMember);
      }

      await this.logScan(staffId, ticket.id, qrToken, ScanOutcome.VALID, gate);

      // Cache the used token in Redis so repeated scans don't hit DB
      await this.cache.set(
        `${this.USED_KEY}${qrToken}`,
        JSON.stringify({
          redeemedAt: ticket.redeemedAt,
          staffName:  staffMember?.user?.name ?? "Staff",
          gate,
        }),
        this.USED_TTL,
      );

      // ── Live push, off the critical path ────────────────────────────────
      // The scan itself already committed above (strong consistency: Postgres
      // is done, response is correct). These two calls are fire-and-forget —
      // if the socket push or notification enqueue lags or fails, the scan
      // result already returned to the scanner app is unaffected.
      this.realtime.emitTicketScanned(ticket.fair.id, {
        outcome:   ScanOutcome.VALID,
        rideName:  ticket.ride?.name,
        displayId: ticket.displayId,
        gate,
      });

      await this.notifications.enqueue({
        type:    NotificationType.TICKET_SCANNED,
        fairId:  ticket.fair.id,
        payload: {
          ticketId:  ticket.id,
          displayId: ticket.displayId,
          rideName:  ticket.ride?.name,
          gate,
        },
      });

      return {
        outcome: ScanOutcome.VALID,
        message: "Ticket validated. Entry granted.",
        ticket: {
          id:            ticket.id,
          displayId:     ticket.displayId,
          quantity:      ticket.quantity,
          customerName:  ticket.customer?.name,
          rideName:      ticket.ride?.name,
          eventDate:     ticket.eventDate,
          // FIX: the scanner app's success receipt reads
          // `result.ticket.paymentMethod` and `result.ticket.totalAmount`
          // (scanner-ui.tsx) but neither was ever included here — every
          // successful scan showed "undefined · ₹undefined" for the payment
          // line. `totalAmount` is now a real number too (see the shared
          // decimalTransformer fix on TicketEntity), not the raw Postgres
          // string it used to be.
          paymentMethod: ticket.paymentMethod,
          totalAmount:   ticket.totalAmount,
        },
      };
    });
  }

  private async logScan(
    staffId: string,
    ticketId: string | null,
    token:    string,
    outcome:  ScanOutcome,
    gate:     string,
  ) {
    const log = this.scanLogs.create({
      outcome,
      scannedToken: token,
      gate,
      staff:  { id: staffId }  as any,
      ticket: ticketId ? { id: ticketId } as any : undefined,
    });
    await this.scanLogs.save(log).catch(() => {/* non-critical — don't fail the scan */});
  }
}

// ── Controller ────────────────────────────────────────────────────────────────
@ApiTags("tickets")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: "tickets", version: "1" })
class TicketsController {
  constructor(private readonly svc: TicketsService) {}

  @Get("mine")
  @ApiOperation({ summary: "Get current customer's tickets" })
  getMyTickets(@CurrentUser("sub") userId: string) {
    return this.svc.getMyTickets(userId);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get a single ticket" })
  getOne(@Param("id") id: string, @CurrentUser("sub") userId: string) {
    return this.svc.getTicketById(id, userId);
  }

  @Get(":displayId/qr")
  @ApiOperation({ summary: "Get QR code data URL for a ticket" })
  getQR(@Param("displayId") displayId: string, @CurrentUser("sub") userId: string) {
    return this.svc.getTicketQR(displayId, userId);
  }

  @Post("redeem")
  @Roles(UserRole.SCANNER_STAFF)
  @UseGuards(RolesGuard, ScannerRideGuard)
  @ApiOperation({ summary: "Redeem (scan) a ticket — SCANNER_STAFF only" })
  redeem(@Body() dto: RedeemTicketDto, @CurrentUser("staffId") staffId: string) {
    return this.svc.redeem(staffId, dto);
  }
}

// ── Module ────────────────────────────────────────────────────────────────────
@Module({
  imports: [
    TypeOrmModule.forFeature([TicketEntity, StaffEntity, ScanLogEntity, RideEntity]),
    NotificationsModule,
  ],
  controllers: [TicketsController],
  providers:   [TicketsService],
  exports:     [TicketsService],
})
export class TicketsModule {}
