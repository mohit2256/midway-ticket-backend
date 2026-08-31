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
  StaffEntity, UserEntity, RideEntity, FairEntity, OperatorEntity,
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
  @ApiProperty() @IsUUID()    rideId: string;
  @ApiProperty() @IsUUID()    fairId: string;
  @ApiProperty() @IsString()  gate:   string;
}

export class UpdateStaffDto {
  @ApiPropertyOptional() @IsUUID()   @IsOptional() rideId?:    string;
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
    @InjectRepository(OperatorEntity) private operators: Repository<OperatorEntity>,
    @InjectRepository(ScanLogEntity)  private scanLogs:  Repository<ScanLogEntity>,
  ) {}

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
    return this.staff.find({
      where:     { operator: { id: operatorId } },
      relations: ["user", "assignedRide", "fair"],
      order:     { createdAt: "DESC" },
    });
  }

  async findOne(id: string, operatorId: string) {
    const member = await this.staff.findOne({
      where:     { id, operator: { id: operatorId } },
      relations: ["user", "assignedRide", "fair"],
    });
    if (!member) throw new NotFoundException("Staff member not found");
    return member;
  }

  async getScanHistory(staffId: string, operatorId: string) {
    const member = await this.staff.findOne({
      where: { id: staffId, operator: { id: operatorId } },
    });
    if (!member) throw new NotFoundException("Staff member not found");

    return this.scanLogs.find({
      where:   { staff: { id: staffId } },
      order:   { scannedAt: "DESC" },
      take:    50,
      relations: ["ticket"],
    });
  }

  async create(dto: CreateStaffDto, operatorId: string) {
    const existingUser = await this.users.findOne({ where: { email: dto.email } });
    if (existingUser) throw new ConflictException("Email already in use");

    const [ride, fair, operator] = await Promise.all([
      this.rides.findOne({ where: { id: dto.rideId } }),
      this.fairs.findOne({ where: { id: dto.fairId } }),
      this.operators.findOne({ where: { id: operatorId } }),
    ]);

    if (!ride)     throw new NotFoundException("Ride not found");
    if (!fair)     throw new NotFoundException("Fair not found");
    if (!operator) throw new NotFoundException("Operator not found");

    const user = this.users.create({
      name:         dto.name,
      email:        dto.email,
      phone:        dto.phone,
      role:         UserRole.SCANNER_STAFF,
      passwordHash: await bcrypt.hash(dto.password, 12),
    });
    await this.users.save(user);

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

    return this.staff.save(member);
  }

  async update(id: string, dto: UpdateStaffDto, operatorId: string) {
    const member = await this.staff.findOne({
      where:     { id, operator: { id: operatorId } },
      relations: ["assignedRide"],
    });
    if (!member) throw new NotFoundException("Staff member not found");

    if (dto.rideId) {
      const ride = await this.rides.findOne({ where: { id: dto.rideId } });
      if (!ride) throw new NotFoundException("Ride not found");
      member.assignedRide = ride;
    }
    if (dto.gate     !== undefined) member.gate     = dto.gate;
    if (dto.isActive !== undefined) member.isActive = dto.isActive;

    return this.staff.save(member);
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
      relations: ["assignedRide", "assignedRide.fair", "fair"],
    });
    if (!member) throw new NotFoundException("No active staff assignment");
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
      StaffEntity, UserEntity, RideEntity, FairEntity, OperatorEntity, ScanLogEntity,
    ]),
  ],
  controllers: [StaffController],
  providers:   [StaffService],
  exports:     [StaffService],
})
export class StaffModule {}
