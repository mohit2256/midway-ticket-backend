import {
  Injectable, NotFoundException, ConflictException, ForbiddenException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import * as bcrypt from "bcrypt";
import {
  IsString, IsEmail, IsUUID, IsOptional,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  Controller, Get, Post, Patch, Delete, Body, Param,
  UseGuards, HttpCode, HttpStatus,
} from "@nestjs/common";
import { ApiTags, ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import {
  StaffEntity, UserEntity, RideEntity, FairEntity, EventEntity, OperatorEntity,
  ScanLogEntity, UserRole,
} from "../entities";
import {
  JwtAuthGuard, RolesGuard, Roles, CurrentUser,
} from "../../common/guards/auth.guards";

// ── DTOs ──────────────────────────────────────────────────────────────────────

export class CreateStaffDto {
  @ApiProperty() @IsString()  name:   string;
  @ApiProperty() @IsEmail()   email:  string;
  @ApiProperty() @IsString()  phone:  string;
  @ApiProperty() @IsString()  password: string;
  // Assign to EITHER a Fair's ride (rideId + fairId together) OR a
  // standalone Event (eventId alone) — never both. Both sides optional here
  // so either combination validates; StaffService.create() enforces exactly
  // one is actually provided.
  @ApiPropertyOptional() @IsUUID() @IsOptional() rideId?:  string;
  @ApiPropertyOptional() @IsUUID() @IsOptional() fairId?:  string;
  @ApiPropertyOptional() @IsUUID() @IsOptional() eventId?: string;
  @ApiProperty() @IsString()  gate:   string;
}

export class UpdateStaffDto {
  @ApiPropertyOptional() @IsUUID()   @IsOptional() rideId?:    string;
  @ApiPropertyOptional() @IsUUID()   @IsOptional() eventId?:   string;
  @ApiPropertyOptional() @IsString() @IsOptional() gate?:      string;
  @ApiPropertyOptional()             @IsOptional() isActive?:  boolean;
}

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class StaffService {
  constructor(
    @InjectRepository(StaffEntity)    private staff:     Repository<StaffEntity>,
    @InjectRepository(UserEntity)     private users:     Repository<UserEntity>,
    @InjectRepository(RideEntity)     private rides:     Repository<RideEntity>,
    @InjectRepository(FairEntity)     private fairs:     Repository<FairEntity>,
    @InjectRepository(EventEntity)    private events:    Repository<EventEntity>,
    @InjectRepository(OperatorEntity) private operators: Repository<OperatorEntity>,
    @InjectRepository(ScanLogEntity)  private scanLogs:  Repository<ScanLogEntity>,
  ) {}

  /**
   * FIX: the frontend's `StaffMember` type expects flat fields —
   * `name`, `email`, `phone`, `fairName`, `rideName`, and a
   * `status: "Active" | "Inactive"` string. `StaffEntity` only ever exposed
   * these nested under `user`/`fair`/`assignedRide`, plus an `isActive`
   * boolean instead of `status` — so every real (non-mock) response left
   * `name`/`email`/`fairName`/`rideName`/`status` all `undefined`. The
   * operator Staff page renders `s.name.charAt(0)` on the very first row,
   * which threw (`undefined.charAt is not a function`) and crashed the
   * whole page — same root cause pattern as the Rides stats bug. This maps
   * the entity (with `user`/`fair`/`assignedRide` relations loaded) onto
   * the exact shape the frontend expects, same style as RidesService's
   * `attachRideStats`.
   */
  private toStaffMember(member: StaffEntity) {
    return {
      id:          member.id,
      name:        member.user?.name ?? "",
      email:       member.user?.email ?? "",
      phone:       member.user?.phone ?? "",
      operatorId:  member.operator?.id ?? "",
      fairId:      member.fair?.id ?? "",
      fairName:    member.fair?.name ?? "",
      rideId:      member.assignedRide?.id ?? "",
      rideName:    member.assignedRide?.name ?? "",
      // Only set when this staff member is assigned to a standalone Event
      // instead of a Fair's ride (see EventEntity / StaffEntity.assignedEvent).
      eventId:     member.assignedEvent?.id ?? "",
      eventName:   member.assignedEvent?.name ?? "",
      gate:        member.gate,
      status:      member.isActive ? "Active" : "Inactive",
      scansToday:  member.scansToday,
      scansTotal:  member.scansTotal,
      lastScanAt:  member.lastScanAt ?? null,
      joinedAt:    member.createdAt,
    };
  }

  /**
   * FIX: same flattening problem as `toStaffMember` above — the frontend's
   * `ScanHistoryEntry` type expects `ticketId`, `customerName`, and
   * `quantity` as flat fields, but they only ever existed nested under
   * `ticket`/`ticket.customer`. Not wired up in the UI yet (the "View"
   * button on the Staff page has no handler), but fixed now so it doesn't
   * repeat the same crash the moment that button is wired up.
   */
  private toScanHistoryEntry(log: ScanLogEntity) {
    return {
      id:           log.id,
      ticketId:     log.ticket?.displayId ?? "",
      customerName: log.ticket?.customer?.name ?? "Unknown",
      quantity:     log.ticket?.quantity ?? 0,
      scannedAt:    log.scannedAt,
      outcome:      log.outcome,
    };
  }

  /**
   * Resolve the OperatorEntity that belongs to this authenticated user.
   * Throws ForbiddenException if the user has no operator profile — prevents
   * any operator-scoped action from falling through with a wrong/stale id.
   */
  async resolveOperator(userId: string): Promise<string> {
    const operator = await this.operators.findOne({ where: { owner: { id: userId } } });
    if (!operator) throw new ForbiddenException("No operator account found for this user");
    return operator.id;
  }

  async findAll(operatorId: string) {
    const members = await this.staff.find({
      where:     { operator: { id: operatorId } },
      relations: ["user", "assignedRide", "fair", "assignedEvent"],
      order:     { createdAt: "DESC" },
    });
    return members.map((m) => this.toStaffMember(m));
  }

  async findOne(id: string, operatorId: string) {
    const member = await this.staff.findOne({
      where:     { id, operator: { id: operatorId } },
      relations: ["user", "assignedRide", "fair", "assignedEvent"],
    });
    if (!member) throw new NotFoundException("Staff member not found");
    return this.toStaffMember(member);
  }

  async getScanHistory(staffId: string, operatorId: string) {
    const member = await this.staff.findOne({
      where: { id: staffId, operator: { id: operatorId } },
    });
    if (!member) throw new NotFoundException("Staff member not found");

    const logs = await this.scanLogs.find({
      where:   { staff: { id: staffId } },
      order:   { scannedAt: "DESC" },
      take:    50,
      relations: ["ticket", "ticket.customer"],
    });
    return logs.map((l) => this.toScanHistoryEntry(l));
  }

  async create(dto: CreateStaffDto, operatorId: string) {
    const existingUser = await this.users.findOne({ where: { email: dto.email } });
    if (existingUser) throw new ConflictException("Email already in use");

    const operator = await this.operators.findOne({ where: { id: operatorId } });
    if (!operator) throw new NotFoundException("Operator not found");

    // Exactly one assignment target: a Fair's ride, or a standalone Event —
    // never both, never neither.
    const hasRideAssignment  = Boolean(dto.rideId && dto.fairId);
    const hasEventAssignment = Boolean(dto.eventId);
    if (hasRideAssignment === hasEventAssignment) {
      throw new NotFoundException(
        "Provide either (rideId + fairId) to assign this staff member to a ride, or eventId to assign them to a standalone event — not both.",
      );
    }

    const user = this.users.create({
      name:         dto.name,
      email:        dto.email,
      phone:        dto.phone,
      role:         UserRole.SCANNER_STAFF,
      passwordHash: await bcrypt.hash(dto.password, 12),
    });
    await this.users.save(user);

    if (hasEventAssignment) {
      const event = await this.events.findOne({
        where: { id: dto.eventId, operator: { id: operatorId } },
      });
      if (!event) throw new NotFoundException("Event not found");

      const existing = await this.staff.findOne({
        where: { user: { id: user.id }, assignedEvent: { id: event.id } },
      });
      if (existing) throw new ConflictException("Staff already assigned to this event");

      const member = this.staff.create({
        gate: dto.gate, user, operator, assignedEvent: event,
      });
      const saved = await this.staff.save(member);
      saved.user = user;
      saved.assignedEvent = event;
      saved.operator = operator;
      return this.toStaffMember(saved);
    }

    const [ride, fair] = await Promise.all([
      this.rides.findOne({ where: { id: dto.rideId } }),
      this.fairs.findOne({ where: { id: dto.fairId } }),
    ]);
    if (!ride) throw new NotFoundException("Ride not found");
    if (!fair) throw new NotFoundException("Fair not found");

    const existing = await this.staff.findOne({
      where: { user: { id: user.id }, fair: { id: fair.id } },
    });
    if (existing) throw new ConflictException("Staff already assigned to this fair");

    const member = this.staff.create({
      gate:         dto.gate,
      user,
      operator,
      fair,
      assignedRide: ride,
    });

    const saved = await this.staff.save(member);
    saved.user = user;
    saved.fair = fair;
    saved.assignedRide = ride;
    saved.operator = operator;
    return this.toStaffMember(saved);
  }

  async update(id: string, dto: UpdateStaffDto, operatorId: string) {
    const member = await this.staff.findOne({
      where:     { id, operator: { id: operatorId } },
      relations: ["user", "assignedRide", "fair", "assignedEvent", "operator"],
    });
    if (!member) throw new NotFoundException("Staff member not found");

    if (dto.rideId) {
      const ride = await this.rides.findOne({ where: { id: dto.rideId } });
      if (!ride) throw new NotFoundException("Ride not found");
      member.assignedRide = ride;
    }
    if (dto.eventId) {
      const event = await this.events.findOne({ where: { id: dto.eventId, operator: { id: operatorId } } });
      if (!event) throw new NotFoundException("Event not found");
      member.assignedEvent = event;
    }
    if (dto.gate     !== undefined) member.gate     = dto.gate;
    if (dto.isActive !== undefined) member.isActive = dto.isActive;

    const saved = await this.staff.save(member);
    return this.toStaffMember(saved);
  }

  async deactivate(id: string, operatorId: string) {
    const member = await this.staff.findOne({
      where: { id, operator: { id: operatorId } },
    });
    if (!member) throw new NotFoundException("Staff member not found");
    member.isActive = false;
    return this.staff.save(member);
  }

  async getMyAssignment(userId: string) {
    const member = await this.staff.findOne({
      where:     { user: { id: userId }, isActive: true },
      relations: ["assignedRide", "assignedRide.fair", "fair", "assignedEvent"],
    });
    if (!member) throw new NotFoundException("No active staff assignment");

    if (member.assignedEvent) {
      return {
        staffId:    member.id,
        gate:       member.gate,
        scansToday: member.scansToday,
        assignedEvent: {
          id:            member.assignedEvent.id,
          name:          member.assignedEvent.name,
          emoji:         member.assignedEvent.emoji,
          coverGradient: member.assignedEvent.coverGradient,
        },
      };
    }

    return {
      staffId:      member.id,
      gate:         member.gate,
      scansToday:   member.scansToday,
      assignedRide: {
        id:            member.assignedRide.id,
        name:          member.assignedRide.name,
        emoji:         member.assignedRide.emoji,
        coverGradient: member.assignedRide.coverGradient,
      },
      assignedFair: {
        id:   member.fair.id,
        name: member.fair.name,
      },
    };
  }
}

// ── Controller ────────────────────────────────────────────────────────────────

@ApiTags("staff")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: "staff", version: "1" })
export class StaffController {
  constructor(private readonly svc: StaffService) {}

  // ── Operator endpoints ─────────────────────────────────────────────────────

  @Get()
  @Roles(UserRole.OPERATOR_OWNER, UserRole.OPERATOR_MANAGER)
  @UseGuards(RolesGuard)
  @ApiOperation({ summary: "List all staff for operator" })
  async findAll(@CurrentUser("sub") userId: string) {
    const operatorId = await this.svc.resolveOperator(userId);
    return this.svc.findAll(operatorId);
  }

  @Get(":id")
  @Roles(UserRole.OPERATOR_OWNER, UserRole.OPERATOR_MANAGER)
  @UseGuards(RolesGuard)
  async findOne(@Param("id") id: string, @CurrentUser("sub") userId: string) {
    const operatorId = await this.svc.resolveOperator(userId);
    return this.svc.findOne(id, operatorId);
  }

  @Get(":id/scans")
  @Roles(UserRole.OPERATOR_OWNER, UserRole.OPERATOR_MANAGER)
  @UseGuards(RolesGuard)
  @ApiOperation({ summary: "Get scan history for a staff member" })
  async getScanHistory(@Param("id") id: string, @CurrentUser("sub") userId: string) {
    const operatorId = await this.svc.resolveOperator(userId);
    return this.svc.getScanHistory(id, operatorId);
  }

  @Post()
  @Roles(UserRole.OPERATOR_OWNER, UserRole.OPERATOR_MANAGER)
  @UseGuards(RolesGuard)
  @ApiOperation({ summary: "Create staff account with ride assignment" })
  async create(@Body() dto: CreateStaffDto, @CurrentUser("sub") userId: string) {
    const operatorId = await this.svc.resolveOperator(userId);
    return this.svc.create(dto, operatorId);
  }

  @Patch(":id")
  @Roles(UserRole.OPERATOR_OWNER, UserRole.OPERATOR_MANAGER)
  @UseGuards(RolesGuard)
  @ApiOperation({ summary: "Update staff assignment or status" })
  async update(
    @Param("id") id: string,
    @Body() dto: UpdateStaffDto,
    @CurrentUser("sub") userId: string,
  ) {
    const operatorId = await this.svc.resolveOperator(userId);
    return this.svc.update(id, dto, operatorId);
  }

  @Delete(":id")
  @Roles(UserRole.OPERATOR_OWNER, UserRole.OPERATOR_MANAGER)
  @UseGuards(RolesGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Deactivate a staff account" })
  async deactivate(@Param("id") id: string, @CurrentUser("sub") userId: string) {
    const operatorId = await this.svc.resolveOperator(userId);
    return this.svc.deactivate(id, operatorId);
  }

  // ── Staff-self endpoint ────────────────────────────────────────────────────

  @Get("me/assignment")
  @Roles(UserRole.SCANNER_STAFF)
  @UseGuards(RolesGuard)
  @ApiOperation({ summary: "Get own ride assignment (SCANNER_STAFF only)" })
  myAssignment(@CurrentUser("sub") userId: string) {
    return this.svc.getMyAssignment(userId);
  }
}

// ── Module ────────────────────────────────────────────────────────────────────

@Module({
  imports: [
    TypeOrmModule.forFeature([
      StaffEntity, UserEntity, RideEntity, FairEntity, EventEntity, OperatorEntity, ScanLogEntity,
    ]),
  ],
  controllers: [StaffController],
  providers:   [StaffService],
  exports:     [StaffService],
})
export class StaffModule {}
