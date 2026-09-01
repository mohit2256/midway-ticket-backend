import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { StaffService } from "./staff.module";
import {
  StaffEntity, UserEntity, RideEntity, FairEntity, OperatorEntity, ScanLogEntity,
} from "../entities";

const mockRepo = () => ({
  find:    jest.fn(),
  findOne: jest.fn(),
  create:  jest.fn(),
  save:    jest.fn(),
  count:   jest.fn(),
});

describe("StaffService", () => {
  let svc:           StaffService;
  let operatorsRepo: ReturnType<typeof mockRepo>;
  let staffRepo:     ReturnType<typeof mockRepo>;

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [
        StaffService,
        { provide: getRepositoryToken(StaffEntity),    useFactory: mockRepo },
        { provide: getRepositoryToken(UserEntity),     useFactory: mockRepo },
        { provide: getRepositoryToken(RideEntity),     useFactory: mockRepo },
        { provide: getRepositoryToken(FairEntity),     useFactory: mockRepo },
        { provide: getRepositoryToken(OperatorEntity), useFactory: mockRepo },
        { provide: getRepositoryToken(ScanLogEntity),  useFactory: mockRepo },
      ],
    }).compile();

    svc           = mod.get(StaffService);
    operatorsRepo = mod.get(getRepositoryToken(OperatorEntity));
    staffRepo     = mod.get(getRepositoryToken(StaffEntity));
  });

  describe("resolveOperator", () => {
    it("returns the operator id for a valid user", async () => {
      operatorsRepo.findOne.mockResolvedValue({ id: "op-abc" });
      await expect(svc.resolveOperator("user-1")).resolves.toBe("op-abc");
    });

    it("throws ForbiddenException when the user has no operator profile", async () => {
      operatorsRepo.findOne.mockResolvedValue(null);
      await expect(svc.resolveOperator("user-x")).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe("findAll", () => {
    it("scopes the query to the given operatorId", async () => {
      staffRepo.find.mockResolvedValue([]);
      await svc.findAll("op-abc");
      expect(staffRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { operator: { id: "op-abc" } } }),
      );
    });
  });

  describe("findOne", () => {
    it("throws NotFoundException when staff belongs to another operator", async () => {
      staffRepo.findOne.mockResolvedValue(null);
      await expect(svc.findOne("staff-1", "op-abc")).rejects.toBeInstanceOf(NotFoundException);
    });

    it("returns the staff member when ownership matches", async () => {
      const member = { id: "staff-1" };
      staffRepo.findOne.mockResolvedValue(member);
      await expect(svc.findOne("staff-1", "op-abc")).resolves.toBe(member);
    });
  });

  describe("deactivate", () => {
    it("prevents deactivating staff owned by another operator", async () => {
      staffRepo.findOne.mockResolvedValue(null);
      await expect(svc.deactivate("staff-1", "op-other")).rejects.toBeInstanceOf(NotFoundException);
    });

    it("sets isActive=false when the operator owns the staff member", async () => {
      const member = { id: "staff-1", isActive: true };
      staffRepo.findOne.mockResolvedValue(member);
      staffRepo.save.mockResolvedValue({ ...member, isActive: false });
      const result = await svc.deactivate("staff-1", "op-abc");
      expect(result.isActive).toBe(false);
    });
  });
});
