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
import { RideEntity, FairEntity, RideCategory, RideStatus } from "../entities";
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
    @InjectRepository(RideEntity)  private rides: Repository<RideEntity>,
    @InjectRepository(FairEntity)  private fairs: Repository<FairEntity>,
  ) {}

  async findByFair(fairId: string) {
    return this.rides.find({ where: { fair: { id: fairId } }, order: { createdAt: "ASC" } });
  }

  async findOne(id: string) {
    const cached = this.rideCache.get(id);
    if (cached) return cached;

    const r = await this.rides.findOne({ where: { id }, relations: ["fair"] });
    if (!r) throw new NotFoundException("Ride not found");

    this.rideCache.set(id, r);
    return r;
  }

  async create(fairId: string, dto: CreateRideDto) {
    const fair = await this.fairs.findOne({ where: { id: fairId } });
    if (!fair) throw new NotFoundException("Fair not found");
    return this.rides.save(this.rides.create({ ...dto, fair }));
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
    return saved;
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
  @ApiOperation({ summary: "Add ride to fair (operator)" })
  create(@Param("fairId") fairId: string, @Body() dto: CreateRideDto) {
    return this.svc.create(fairId, dto);
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
  imports: [TypeOrmModule.forFeature([RideEntity, FairEntity])],
  controllers: [RidesController],
  providers: [RidesService],
  exports: [RidesService],
})
export class RidesModule {}
