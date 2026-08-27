import { Injectable, NotFoundException } from "@nestjs/common";
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
import { JwtAuthGuard, RolesGuard, Roles } from "../../common/guards/auth.guards";
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
  // App-level LRU, in front of Postgres, for single-ride lookups. Bounded to
  // 200 rides — comfortably covers every ride across every fair a single API
  // process would realistically have "hot" at once (a fair rarely runs more
  // than a few dozen rides). See lru-cache.ts for why LRU fits rides
  // specifically (recency-bursty scan traffic).
  private readonly rideCache = new LruCache<string, RideEntity>(200);

  constructor(
    @InjectRepository(RideEntity) private rides: Repository<RideEntity>,
    @InjectRepository(FairEntity) private fairs: Repository<FairEntity>,
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

  async update(id: string, dto: UpdateRideDto) {
    const r = await this.rides.findOne({ where: { id } });
    if (!r) throw new NotFoundException("Ride not found");
    Object.assign(r, dto);
    const saved = await this.rides.save(r);
    // Invalidate — a stale cached ride (old price/status) is worse than a
    // cache miss. The next findOne() repopulates it from Postgres.
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
  @ApiOperation({ summary: "Update ride (operator)" })
  update(@Param("id") id: string, @Body() dto: UpdateRideDto) {
    return this.svc.update(id, dto);
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([RideEntity, FairEntity])],
  controllers: [RidesController],
  providers: [RidesService],
  exports: [RidesService],
})
export class RidesModule {}
