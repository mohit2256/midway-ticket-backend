import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { RidesService } from "./rides.module";
import { RideEntity, FairEntity } from "../entities";

const mockRepo = () => ({ find: jest.fn(), findOne: jest.fn(), create: jest.fn(), save: jest.fn() });

describe("RidesService", () => {
  let svc:       RidesService;
  let ridesRepo: ReturnType<typeof mockRepo>;

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [
        RidesService,
        { provide: getRepositoryToken(RideEntity), useFactory: mockRepo },
        { provide: getRepositoryToken(FairEntity), useFactory: mockRepo },
      ],
    }).compile();
    svc       = mod.get(RidesService);
    ridesRepo = mod.get(getRepositoryToken(RideEntity));
  });

  describe("update — ownership enforcement", () => {
    const ownerId  = "user-owner";
    const otherId  = "user-other";
    const rideStub = {
      id:   "ride-1",
      fair: { operator: { owner: { id: ownerId } } },
    } as unknown as RideEntity;

    it("throws NotFoundException when ride does not exist", async () => {
      ridesRepo.findOne.mockResolvedValue(null);
      await expect(svc.update("ride-x", {}, ownerId)).rejects.toBeInstanceOf(NotFoundException);
    });

    it("throws ForbiddenException when caller does not own the ride", async () => {
      ridesRepo.findOne.mockResolvedValue(rideStub);
      await expect(svc.update("ride-1", {}, otherId)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("allows update when caller owns the ride", async () => {
      const updated = { ...rideStub, pricePerPerson: 150 };
      ridesRepo.findOne.mockResolvedValue({ ...rideStub });
      ridesRepo.save.mockResolvedValue(updated);
      const result = await svc.update("ride-1", { pricePerPerson: 150 }, ownerId);
      expect(result.pricePerPerson).toBe(150);
    });

    it("evicts the LRU cache entry on successful update", async () => {
      ridesRepo.findOne.mockResolvedValue({ ...rideStub });
      ridesRepo.save.mockResolvedValue({ ...rideStub });
      // Pre-warm cache
      (svc as any).rideCache.set("ride-1", rideStub);
      expect((svc as any).rideCache.get("ride-1")).toBeDefined();
      await svc.update("ride-1", {}, ownerId);
      expect((svc as any).rideCache.get("ride-1")).toBeUndefined();
    });
  });
});
