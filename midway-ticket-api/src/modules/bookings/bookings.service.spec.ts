import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { getQueueToken } from "@nestjs/bullmq";
import { ConfigService } from "@nestjs/config";
import { CACHE_MANAGER } from "@nestjs/cache-manager";
import { DataSource } from "typeorm";
import { BookingsService } from "./bookings.module";
import {
  TicketEntity, PaymentEntity, RideEntity, FairEntity, UserEntity,
} from "../entities";
import { NotificationsService } from "../notifications/notifications.module";

const mockRepo = () => ({
  find: jest.fn(), findOne: jest.fn(), create: jest.fn(), save: jest.fn(), count: jest.fn(),
});

describe("BookingsService", () => {
  let svc: BookingsService;
  let ridesRepo: ReturnType<typeof mockRepo>;
  let cache: { get: jest.Mock; set: jest.Mock };
  let db: { transaction: jest.Mock };

  beforeEach(async () => {
    cache = { get: jest.fn().mockResolvedValue(null), set: jest.fn() };
    db    = { transaction: jest.fn() };

    const mod = await Test.createTestingModule({
      providers: [
        BookingsService,
        { provide: getRepositoryToken(TicketEntity),  useFactory: mockRepo },
        { provide: getRepositoryToken(PaymentEntity), useFactory: mockRepo },
        { provide: getRepositoryToken(RideEntity),    useFactory: mockRepo },
        { provide: getRepositoryToken(FairEntity),    useFactory: mockRepo },
        { provide: getRepositoryToken(UserEntity),    useFactory: mockRepo },
        { provide: DataSource,                        useValue: db },
        { provide: getQueueToken("email"),            useValue: { add: jest.fn() } },
        { provide: CACHE_MANAGER,                     useValue: cache },
        {
          provide:  ConfigService,
          useValue: { get: jest.fn((_key: string, def: any) => def) },
        },
        {
          provide:  NotificationsService,
          useValue: { enqueue: jest.fn() },
        },
      ],
    }).compile();

    svc       = mod.get(BookingsService);
    ridesRepo = mod.get(getRepositoryToken(RideEntity));
  });

  // ── Idempotency ────────────────────────────────────────────────────────────

  describe("idempotency", () => {
    it("returns the cached result on a duplicate idempotency key — no second DB write", async () => {
      const cached = { ticket: { id: "t-1" } };
      cache.get.mockResolvedValue(cached);

      const result = await svc.createBooking(
        "user-1",
        { rideId: "ride-1", quantity: 1 } as any,
        "idem-key-1",
      );

      expect(result).toBe(cached);
      // The ride repo must NOT be touched — we short-circuited before any DB work
      expect(ridesRepo.findOne).not.toHaveBeenCalled();
    });

    it("stores result under the scoped cache key after a first successful booking", async () => {
      ridesRepo.findOne.mockResolvedValue({
        id: "ride-1", status: "Active", pricePerPerson: 100,
        fair: { id: "fair-1" },
      });
      db.transaction.mockImplementation(async (_lvl: any, fn: any) => {
        const em = {
          getRepository: () => ({
            createQueryBuilder: () => ({
              setLock: () => ({ where: () => ({ getOne: async () => ({
                id: "ride-1", status: "Active", pricePerPerson: 100, capacity: 50,
              }) }) }),
            }),
            count:  jest.fn().mockResolvedValue(0),
            create: jest.fn().mockReturnValue({ id: "t-2" }),
            save:   jest.fn().mockResolvedValue({ id: "t-2" }),
          }),
          save: jest.fn().mockResolvedValue({}),
        };
        return fn(em);
      });

      await svc.createBooking("user-1", { rideId: "ride-1", quantity: 1 } as any, "idem-key-2");

      expect(cache.set).toHaveBeenCalledWith(
        "idempotency:booking:user-1:idem-key-2",
        expect.anything(),
        expect.any(Number),
      );
    });

    it("skips the cache entirely when no idempotency key is provided", async () => {
      ridesRepo.findOne.mockResolvedValue(null); // will throw NotFoundException
      await expect(
        svc.createBooking("user-1", { rideId: "bad-ride", quantity: 1 } as any),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(cache.get).not.toHaveBeenCalled();
    });
  });

  // ── Input validation ───────────────────────────────────────────────────────

  describe("createBooking — validation", () => {
    it("throws NotFoundException for an unknown rideId", async () => {
      ridesRepo.findOne.mockResolvedValue(null);
      await expect(svc.createBooking("u1", { rideId: "x", quantity: 1 } as any))
        .rejects.toBeInstanceOf(NotFoundException);
    });

    it("throws BadRequestException when the ride is not Active", async () => {
      ridesRepo.findOne.mockResolvedValue({
        id: "ride-1", status: "Closed", pricePerPerson: 100, fair: {},
      });
      await expect(svc.createBooking("u1", { rideId: "ride-1", quantity: 1 } as any))
        .rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
