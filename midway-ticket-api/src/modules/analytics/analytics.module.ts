import { Injectable, ForbiddenException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Inject } from "@nestjs/common";
import { CACHE_MANAGER } from "@nestjs/cache-manager";
import { Cache } from "cache-manager";
import {
  Controller, Get, UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { TicketEntity, RideEntity, FairEntity, OperatorEntity, PaymentStatus } from "../entities";
import { JwtAuthGuard, RolesGuard, Roles, CurrentUser } from "../../common/guards/auth.guards";
import { UserRole } from "../entities";

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class AnalyticsService {
  private readonly CACHE_TTL = 60_000;

  constructor(
    @InjectRepository(TicketEntity)   private tickets:   Repository<TicketEntity>,
    @InjectRepository(RideEntity)     private rides:     Repository<RideEntity>,
    @InjectRepository(FairEntity)     private fairs:     Repository<FairEntity>,
    @InjectRepository(OperatorEntity) private operators: Repository<OperatorEntity>,
    @Inject(CACHE_MANAGER)            private cache:     Cache,
  ) {}

  /**
   * Resolve the operator that owns this user account.
   * Identical pattern to StaffService — centralising into a shared helper is
   * a nice-to-have for a later refactor once an OperatorsService exists.
   */
  async resolveOperator(userId: string): Promise<string> {
    const operator = await this.operators.findOne({ where: { owner: { id: userId } } });
    if (!operator) throw new ForbiddenException("No operator account found for this user");
    return operator.id;
  }

  async getDashboard(operatorId: string) {
    const cacheKey = `analytics:dashboard:${operatorId}`;
    const cached   = await this.cache.get(cacheKey);
    if (cached) return cached;

    const today = new Date().toISOString().split("T")[0];

    const todayStats = await this.tickets
      .createQueryBuilder("t")
      .leftJoin("t.fair", "f")
      .leftJoin("f.operator", "o")
      .select([
        "COUNT(t.id)           AS ticketCount",
        "SUM(t.totalAmount)    AS revenue",
        "SUM(t.quantity)       AS visitors",
      ])
      .where("o.id = :operatorId", { operatorId })
      .andWhere("t.paymentStatus = :paid",  { paid: PaymentStatus.PAID })
      .andWhere("DATE(t.createdAt) = :today", { today })
      .getRawOne();

    const yesterday = new Date(Date.now() - 86_400_000).toISOString().split("T")[0];
    const yStats = await this.tickets
      .createQueryBuilder("t")
      .leftJoin("t.fair", "f").leftJoin("f.operator", "o")
      .select(["SUM(t.totalAmount) AS revenue", "COUNT(t.id) AS ticketCount"])
      .where("o.id = :operatorId", { operatorId })
      .andWhere("t.paymentStatus = :paid", { paid: PaymentStatus.PAID })
      .andWhere("DATE(t.createdAt) = :yesterday", { yesterday })
      .getRawOne();

    const hourly = await this.tickets
      .createQueryBuilder("t")
      .leftJoin("t.fair", "f").leftJoin("f.operator", "o")
      .select([
        "EXTRACT(HOUR FROM t.createdAt AT TIME ZONE 'Asia/Kolkata') AS hour",
        "COUNT(t.id)        AS tickets",
        "SUM(t.totalAmount) AS revenue",
      ])
      .where("o.id = :operatorId", { operatorId })
      .andWhere("t.paymentStatus = :paid", { paid: PaymentStatus.PAID })
      .andWhere("DATE(t.createdAt) = :today", { today })
      .groupBy("hour")
      .orderBy("hour", "ASC")
      .getRawMany();

    const ridePerf = await this.tickets
      .createQueryBuilder("t")
      .leftJoin("t.ride", "r")
      .leftJoin("t.fair", "f").leftJoin("f.operator", "o")
      .select([
        "r.id                AS rideId",
        "r.name              AS rideName",
        "r.status            AS status",
        "COUNT(t.id)         AS tickets",
        "SUM(t.totalAmount)  AS revenue",
      ])
      .where("o.id = :operatorId", { operatorId })
      .andWhere("t.paymentStatus = :paid", { paid: PaymentStatus.PAID })
      .andWhere("DATE(t.createdAt) = :today", { today })
      .groupBy("r.id, r.name, r.status")
      .orderBy("revenue", "DESC")
      .getRawMany();

    const activeRides = await this.rides
      .createQueryBuilder("r")
      .leftJoin("r.fair", "f").leftJoin("f.operator", "o")
      .where("o.id = :operatorId", { operatorId })
      .andWhere("r.status = 'Active'")
      .getCount();

    const revenueChange = yStats?.revenue
      ? ((todayStats.revenue - yStats.revenue) / yStats.revenue) * 100
      : 0;

    const ticketChange = yStats?.ticketCount
      ? ((todayStats.ticketCount - yStats.ticketCount) / yStats.ticketCount) * 100
      : 0;

    const result = {
      revenueToday:       Number(todayStats?.revenue)     || 0,
      revenueTodayChange: Math.round(revenueChange * 10) / 10,
      ticketsSoldToday:   Number(todayStats?.ticketCount) || 0,
      ticketsSoldChange:  Math.round(ticketChange * 10)   / 10,
      visitorsToday:      Number(todayStats?.visitors)    || 0,
      visitorsChange:     Math.round(ticketChange * 10)   / 10,
      activeRides,
      hourlyData:      this.formatHourly(hourly),
      ridePerformance: ridePerf.map((r) => ({
        rideId:        r.rideid,
        rideName:      r.ridename,
        status:        r.status,
        tickets:       Number(r.tickets),
        revenue:       Number(r.revenue),
        changePercent: 0,
      })),
    };

    await this.cache.set(cacheKey, result, this.CACHE_TTL);
    return result;
  }

  async getWeeklyData(operatorId: string) {
    const days = [...Array(7)].map((_, i) => {
      const d = new Date(Date.now() - i * 86_400_000);
      return d.toISOString().split("T")[0];
    }).reverse();

    return Promise.all(
      days.map(async (day) => {
        const row = await this.tickets
          .createQueryBuilder("t")
          .leftJoin("t.fair", "f").leftJoin("f.operator", "o")
          .select(["COUNT(t.id) AS tickets", "SUM(t.totalAmount) AS revenue"])
          .where("o.id = :operatorId", { operatorId })
          .andWhere("t.paymentStatus = :paid", { paid: PaymentStatus.PAID })
          .andWhere("DATE(t.createdAt) = :day", { day })
          .getRawOne();
        return {
          day:     new Date(day).toLocaleDateString("en-IN", { weekday: "short" }),
          tickets: Number(row?.tickets) || 0,
          revenue: Number(row?.revenue) || 0,
        };
      }),
    );
  }

  private formatHourly(raw: any[]) {
    return Array.from({ length: 24 }, (_, h) => {
      const found = raw.find((r) => Number(r.hour) === h);
      const label = h === 0 ? "12AM"
        : h < 12 ? `${h}AM`
        : h === 12 ? "12PM"
        : `${h - 12}PM`;
      return {
        time:    label,
        tickets: Number(found?.tickets) || 0,
        revenue: Number(found?.revenue) || 0,
      };
    }).filter((_, h) => h >= 8 && h <= 22);
  }
}

// ── Controller ────────────────────────────────────────────────────────────────

@ApiTags("analytics")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR_OWNER, UserRole.OPERATOR_MANAGER)
@Controller({ path: "analytics", version: "1" })
export class AnalyticsController {
  constructor(private readonly svc: AnalyticsService) {}

  @Get("dashboard")
  @ApiOperation({ summary: "Full operator dashboard stats" })
  async dashboard(@CurrentUser("sub") userId: string) {
    const operatorId = await this.svc.resolveOperator(userId);
    return this.svc.getDashboard(operatorId);
  }

  @Get("weekly")
  @ApiOperation({ summary: "7-day ticket & revenue breakdown" })
  async weekly(@CurrentUser("sub") userId: string) {
    const operatorId = await this.svc.resolveOperator(userId);
    return this.svc.getWeeklyData(operatorId);
  }
}

// ── Module ────────────────────────────────────────────────────────────────────

@Module({
  imports:     [TypeOrmModule.forFeature([TicketEntity, RideEntity, FairEntity, OperatorEntity])],
  controllers: [AnalyticsController],
  providers:   [AnalyticsService],
  exports:     [AnalyticsService],
})
export class AnalyticsModule {}
