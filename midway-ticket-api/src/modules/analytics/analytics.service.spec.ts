import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ForbiddenException } from "@nestjs/common";
import { CACHE_MANAGER } from "@nestjs/cache-manager";
import { AnalyticsService } from "./analytics.module";
import { TicketEntity, RideEntity, FairEntity, OperatorEntity } from "../entities";

const mockRepo = () => ({
  find: jest.fn(), findOne: jest.fn(), create: jest.fn(), save: jest.fn(),
  createQueryBuilder: jest.fn().mockReturnValue({
    leftJoin: jest.fn().mockReturnThis(),
    select:   jest.fn().mockReturnThis(),
    where:    jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    groupBy:  jest.fn().mockReturnThis(),
    orderBy:  jest.fn().mockReturnThis(),
    getRawOne:  jest.fn().mockResolvedValue({ ticketCount: "5", revenue: "500", visitors: "5" }),
    getRawMany: jest.fn().mockResolvedValue([]),
    getCount:   jest.fn().mockResolvedValue(3),
  }),
});

describe("AnalyticsService", () => {
  let svc:           AnalyticsService;
  let operatorsRepo: ReturnType<typeof mockRepo>;
  let cache:         { get: jest.Mock; set: jest.Mock };

  beforeEach(async () => {
    cache = { get: jest.fn().mockResolvedValue(null), set: jest.fn() };

    const mod = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        { provide: getRepositoryToken(TicketEntity),   useFactory: mockRepo },
        { provide: getRepositoryToken(RideEntity),     useFactory: mockRepo },
        { provide: getRepositoryToken(FairEntity),     useFactory: mockRepo },
        { provide: getRepositoryToken(OperatorEntity), useFactory: mockRepo },
        { provide: CACHE_MANAGER,                      useValue: cache },
      ],
    }).compile();

    svc           = mod.get(AnalyticsService);
    operatorsRepo = mod.get(getRepositoryToken(OperatorEntity));
  });

  describe("resolveOperator", () => {
    it("returns operator id for a legitimate user", async () => {
      operatorsRepo.findOne.mockResolvedValue({ id: "op-real" });
      await expect(svc.resolveOperator("user-1")).resolves.toBe("op-real");
    });

    it("throws ForbiddenException for a user with no operator account", async () => {
      operatorsRepo.findOne.mockResolvedValue(null);
      await expect(svc.resolveOperator("random-user")).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe("getDashboard — caching", () => {
    it("returns cached value without hitting the DB on second call", async () => {
      const cached = { revenueToday: 1234 };
      cache.get.mockResolvedValue(cached);
      const result = await svc.getDashboard("op-1");
      expect(result).toBe(cached);
    });

    it("scopes all queries to the given operatorId", async () => {
      const ticketQb = (svc as any).tickets.createQueryBuilder();
      await svc.getDashboard("op-xyz");
      expect(ticketQb.where).toHaveBeenCalledWith(
        expect.stringContaining("o.id"),
        expect.objectContaining({ operatorId: "op-xyz" }),
      );
    });
  });
});
