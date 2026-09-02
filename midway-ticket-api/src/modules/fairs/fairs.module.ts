import { Injectable, NotFoundException, ForbiddenException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { IsString, IsDateString, IsOptional, IsEnum } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Controller, Get, Post, Patch, Body, Param, Query, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { FairEntity, FairStatus, OperatorEntity } from "../entities";
import { JwtAuthGuard, RolesGuard, Roles, CurrentUser } from "../../common/guards/auth.guards";
import { UserRole } from "../entities";
import { LfuCache } from "../../common/cache/lfu-cache";

// ── DTOs ──────────────────────────────────────────────────────────────────────
class CreateFairDto {
  @ApiProperty()   @IsString()      name:        string;
  @ApiProperty()   @IsString()      location:    string;
  @ApiProperty()   @IsString()      city:        string;
  @ApiProperty()   @IsDateString()  startDate:   string;
  @ApiProperty()   @IsDateString()  endDate:     string;
  @ApiPropertyOptional() @IsString() @IsOptional() description?:   string;
  @ApiPropertyOptional() @IsString() @IsOptional() coverGradient?: string;
  @ApiPropertyOptional() @IsString() @IsOptional() emoji?:         string;
}

class UpdateFairDto {
  @ApiPropertyOptional() @IsString()          @IsOptional() name?:      string;
  @ApiPropertyOptional() @IsDateString()       @IsOptional() startDate?: string;
  @ApiPropertyOptional() @IsDateString()       @IsOptional() endDate?:   string;
  @ApiPropertyOptional() @IsEnum(FairStatus)  @IsOptional() status?:    FairStatus;
}

// ── Service ───────────────────────────────────────────────────────────────────
@Injectable()
export class FairsService {
  // App-level LFU for single-fair detail lookups (see lfu-cache.ts for why
  // fairs — "events" — fit frequency-based eviction better than LRU: a
  // featured/popular fair gets sustained traffic over its whole run, not a
  // recency burst). Bounded to 50 — generous for how many fairs are
  // simultaneously "active" system-wide at once.
  private readonly fairCache = new LfuCache<string, FairEntity>(50);

  constructor(
    @InjectRepository(FairEntity)     private fairs:     Repository<FairEntity>,
    @InjectRepository(OperatorEntity) private operators: Repository<OperatorEntity>,
  ) {}

  async findAll(city?: string) {
    const qb = this.fairs
      .createQueryBuilder("f")
      .leftJoinAndSelect("f.rides", "r")
      .where("f.status != :draft", { draft: FairStatus.DRAFT });
    if (city) qb.andWhere("LOWER(f.city) LIKE :city", { city: `%${city.toLowerCase()}%` });
    return qb.getMany();
  }

  async findOne(id: string) {
    const cached = this.fairCache.get(id);
    if (cached) return cached;

    const fair = await this.fairs.findOne({
      where: { id },
      relations: ["rides", "operator"],
    });
    if (!fair) throw new NotFoundException("Fair not found");

    this.fairCache.set(id, fair);
    return fair;
  }

  /**
   * FIX: `findByOperator` filters by `operator.id` (the OperatorEntity's own
   * primary key), which is NOT the same as the logged-in user's id. The
   * controller was previously passing the raw JWT `sub` (a userId) straight
   * through here, so the query never matched and every operator's "My
   * Fairs" list came back empty. Resolve userId → operatorId first, same
   * pattern already used in AnalyticsService/StaffService.
   */
  async resolveOperator(userId: string): Promise<string> {
    const operator = await this.operators.findOne({ where: { owner: { id: userId } } });
    if (!operator) throw new ForbiddenException("No operator account found for this user");
    return operator.id;
  }

  async findByOperator(operatorId: string) {
    return this.fairs.find({
      where: { operator: { id: operatorId } },
      relations: ["rides"],
      order: { createdAt: "DESC" },
    });
  }

  async create(dto: CreateFairDto, userId: string) {
    const operator = await this.operators.findOne({ where: { owner: { id: userId } } });
    if (!operator) throw new ForbiddenException("No operator account found");
    const fair = this.fairs.create({ ...dto, operator });
    return this.fairs.save(fair);
  }

  async update(id: string, dto: UpdateFairDto, userId: string) {
    const fair = await this.fairs.findOne({
      where: { id },
      relations: ["operator", "operator.owner"],
    });
    if (!fair) throw new NotFoundException("Fair not found");
    if (fair.operator.owner.id !== userId) throw new ForbiddenException();
    Object.assign(fair, dto);
    const saved = await this.fairs.save(fair);
    // Invalidate so an updated fair (status, dates) isn't served stale.
    this.fairCache.delete(id);
    return saved;
  }
}

// ── Controller ────────────────────────────────────────────────────────────────
@ApiTags("fairs")
@Controller({ path: "fairs", version: "1" })
export class FairsController {
  constructor(private readonly svc: FairsService) {}

  @Get()
  @ApiOperation({ summary: "List all active fairs (public)" })
  findAll(@Query("city") city?: string) {
    return this.svc.findAll(city);
  }

  @Get("operator/mine")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.OPERATOR_OWNER, UserRole.OPERATOR_MANAGER)
  @ApiOperation({ summary: "List operator's own fairs" })
  async myFairs(@CurrentUser("sub") userId: string) {
    const operatorId = await this.svc.resolveOperator(userId);
    return this.svc.findByOperator(operatorId);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get fair detail with rides (public)" })
  findOne(@Param("id") id: string) {
    return this.svc.findOne(id);
  }

  @Post()
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.OPERATOR_OWNER, UserRole.OPERATOR_MANAGER)
  @ApiOperation({ summary: "Create a new fair (operator)" })
  create(@Body() dto: CreateFairDto, @CurrentUser("sub") userId: string) {
    return this.svc.create(dto, userId);
  }

  @Patch(":id")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.OPERATOR_OWNER, UserRole.OPERATOR_MANAGER)
  @ApiOperation({ summary: "Update fair (operator)" })
  update(@Param("id") id: string, @Body() dto: UpdateFairDto, @CurrentUser("sub") userId: string) {
    return this.svc.update(id, dto, userId);
  }
}

// ── Module ────────────────────────────────────────────────────────────────────
@Module({
  imports: [TypeOrmModule.forFeature([FairEntity, OperatorEntity])],
  controllers: [FairsController],
  providers: [FairsService],
  exports: [FairsService],
})
export class FairsModule {}
