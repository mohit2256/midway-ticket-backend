import { Injectable, NotFoundException, ForbiddenException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { IsString, IsNumber, IsInt, IsEnum, IsOptional } from "class-validator";
import { Type } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Controller, Get, Post, Patch, Body, Param, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { RideEntity, FairEntity, TicketEntity, RideCategory, RideStatus, PaymentStatus } from "../entities";
import { JwtAuthGuard, RolesGuard, Roles, CurrentUser } from "../../common/guards/auth.guards";
import { UserRole } from "../entities";
import { LruCache } from "../../common/cache/lru-cache";

class CreateRideDto {
  @ApiProperty() @IsString() name: string;
  @ApiPropertyOptional() @IsString() @IsOptional() description?: string;
  @ApiProperty() @IsEnum(RideCategory) category: RideCategory;
  @ApiPropertyOptional() @IsString() @IsOptional() emoji?: string;
  @ApiPropertyOptional() @IsString() @IsOptional() coverGradient?: string;
  @ApiProperty() @IsNumber() @Type(() => Number) pricePerPerson: number;
  @ApiPropertyOptional() @IsInt() @IsOptional() @Type(() => Number) durationMinutes?: number;
  @ApiPropertyOptional() @IsInt() @IsOptional() @Type(() => Number) minAge?: number;
  @ApiPropertyOptional() @IsInt() @IsOptional() @Type(() => Number) capacity?: number;
}

class UpdateRideDto {
  @ApiPropertyOptional() @IsNumber() @IsOptional() @Type(() => Number) pricePerPerson?: number;
  @ApiPropertyOptional() @IsEnum(RideStatus) @IsOptional() status?: RideStatus;
  @ApiPropertyOptional() @IsString() @IsOptional() name?: string;
}

@Injectable()
export class RidesService {
  private readonly rideCache = new LruCache<string, RideEntity>(200);

  constructor(
    @InjectRepository(RideEntity)   private rides:   Repository<RideEntity>,
    @InjectRepository(FairEntity)   private fairs:   Repository<FairEntity>,
    @InjectRepository(TicketEntity) private tickets: Repository<TicketEntity>,
  ) {}

  async findByFair(fairId: string) {
    const rides = await this.rides.find({ where: { fair: { id: fairId } }, order: { createdAt: "ASC" } });
    return this.attachRideStats(rides);
  }

  async findOne(id: string) {
    const cached = this.rideCache.get(id);
    if (cached) return (await this.attachRideStats([cached]))[0];

    const r = await this.rides.findOne({ where: { id }, relations: ["fair"] });
    if (!r) throw new NotFoundException("Ride not found");

    this.rideCache.set(id, r);
    return (await this.attachRideStats([r]))[0];
  }

  /**
   * FIX: the frontend's `Ride` type expects `ticketsSoldToday` and
   * `totalRevenue` on every ride — the operator Rides page renders both
   * directly, including `formatCurrency(ride.totalRevenue)`, which threw
   * (`undefined.toLocaleString(...)`) and crashed the whole page for any
   * ride created through the real API, because neither field existed on
   * `RideEntity` at all. These are computed here (not stored columns) via
   * one grouped query for the whole batch — same join-based style as
   * AnalyticsService's ridePerformance query, so this avoids guessing the
   * actual FK column name and stays correct regardless of TypeORM's naming
   * strategy.
   */
  private async attachRideStats(rides: RideEntity[]) {
    if (rides.length === 0) return [];
    const ids = rides.map((r) => r.id);
    const today = new Date().toISOString().split("T")[0];

    const rows = await this.tickets
      .createQueryBuilder("t")
      .leftJoin("t.ride", "r")
      .select("r.id", "rideid")
      .addSelect("COUNT(t.id) FILTER (WHERE DATE(t.createdAt) = :today)", "ticketstoday")
      .addSelect("COALESCE(SUM(t.totalAmount), 0)", "totalrevenue")
      .where("r.id IN (:...ids)", { ids })
      .andWhere("t.paymentStatus = :paid", { paid: PaymentStatus.PAID })
      .groupBy("r.id")
      .setParameter("today", today)
      .getRawMany();

    const statsById = new Map<string, { ticketstoday: string; totalrevenue: string }>(
      rows.map((row: any) => [row.rideid, row]),
    );

    return rides.map((ride) => {
      const stats = statsById.get(ride.id);
      return {
        ...ride,
        ticketsSoldToday: Number(stats?.ticketstoday) || 0,
        totalRevenue:     Number(stats?.totalrevenue) || 0,
      };
    });
  }

  /**
   * FIX: this previously never checked who owns `fairId` — only the role
   * guard (@Roles OPERATOR_OWNER/MANAGER) was enforced, which just proves
   * the caller is *some* operator, not that they own *this* fair. Any
   * logged-in operator could add rides to a competitor's fair by passing
   * its id. Same ownership chain check as update() below, applied before
   * the fair is used.
   */
  async create(fairId: string, dto: CreateRideDto, userId: string) {
    const fair = await this.fairs.findOne({
      where:     { id: fairId },
      relations: ["operator", "operator.owner"],
    });
    if (!fair) throw new NotFoundException("Fair not found");

    if (fair.operator?.owner?.id !== userId) {
      throw new ForbiddenException("You do not own this fair");
    }

    const saved = await this.rides.save(this.rides.create({ ...dto, fair }));
    return (await this.attachRideStats([saved]))[0];
  }

  /**
   * Update a ride — only the operator that owns the ride's fair may do this.
   * Ownership chain: ride → fair → operator → owner (userId from JWT).
   * We load the full chain here so we can reject cross-operator tampering
   * before touching the row, rather than relying on a WHERE-clause silently
   * returning 0 rows (which would give a confusing 404 instead of 403).
   */
  async update(id: string, dto: UpdateRideDto, userId: string) {
    const ride = await this.rides.findOne({
      where:     { id },
      relations: ["fair", "fair.operator", "fair.operator.owner"],
    });
    if (!ride) throw new NotFoundException("Ride not found");

    if (ride.fair?.operator?.owner?.id !== userId) {
      throw new ForbiddenException("You do not own this ride");
    }

    Object.assign(ride, dto);
    const saved = await this.rides.save(ride);
    // Invalidate cache — stale price/status is worse than a miss.
    this.rideCache.delete(id);
    return (await this.attachRideStats([saved]))[0];
  }
}

@ApiTags("rides")
@Controller({ path: "rides", version: "1" })
export class RidesController {
  constructor(private readonly svc: RidesService) {}

  @Get("fair/:fairId")
  @ApiOperation({ summary: "Get all rides for a fair (public)" })
  findByFair(@Param("fairId") fairId: string) { return this.svc.findByFair(fairId); }

  @Get(":id")
  @ApiOperation({ summary: "Get ride detail (public)" })
  findOne(@Param("id") id: string) { return this.svc.findOne(id); }

  @Post("fair/:fairId")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.OPERATOR_OWNER, UserRole.OPERATOR_MANAGER)
  @ApiOperation({ summary: "Add ride to fair (operator — must own the fair)" })
  create(
    @Param("fairId") fairId: string,
    @Body() dto: CreateRideDto,
    @CurrentUser("sub") userId: string,
  ) {
    return this.svc.create(fairId, dto, userId);
  }

  @Patch(":id")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.OPERATOR_OWNER, UserRole.OPERATOR_MANAGER)
  @ApiOperation({ summary: "Update ride (operator — must own the ride's fair)" })
  update(
    @Param("id") id: string,
    @Body() dto: UpdateRideDto,
    @CurrentUser("sub") userId: string,
  ) {
    return this.svc.update(id, dto, userId);
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([RideEntity, FairEntity, TicketEntity])],
  controllers: [RidesController],
  providers: [RidesService],
  exports: [RidesService],
})
export class RidesModule {}
