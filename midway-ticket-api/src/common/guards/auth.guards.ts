// ── JWT Payload ───────────────────────────────────────────────────────────────
export interface JwtPayload {
  sub:      string;   // userId
  email:    string;
  role:     string;
  // For staff: include their assignment so the backend can verify quickly
  staffId?:       string;
  assignedRideId?: string;
  assignedFairId?: string;
  // Set instead of assignedRideId/assignedFairId when this staff member is
  // assigned to a standalone Event rather than a Fair's ride.
  assignedEventId?: string;
}

// ── JWT Strategy ──────────────────────────────────────────────────────────────
import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { UserEntity } from "../../modules/entities";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, "jwt") {
  constructor(
    cfg: ConfigService,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
  ) {
    super({
      jwtFromRequest:   ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey:      cfg.get<string>("app.jwt.secret", "change-me"),
    });
  }

  async validate(payload: JwtPayload) {
    const user = await this.users.findOne({ where: { id: payload.sub, isActive: true } });
    if (!user) throw new UnauthorizedException("Invalid or expired token");
    return { ...user, ...payload };  // attach payload extras (staffId, assignedRideId)
  }
}

// ── Auth Guards ───────────────────────────────────────────────────────────────
import {
  CanActivate, ExecutionContext, SetMetadata, createParamDecorator, ForbiddenException,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { Reflector } from "@nestjs/core";
import { UserRole } from "../../modules/entities";

export const ROLES_KEY = "roles";
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

@Injectable()
export class JwtAuthGuard extends AuthGuard("jwt") {
  handleRequest(err: any, user: any) {
    if (err || !user) throw err || new UnauthorizedException("Authentication required");
    return user;
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      ctx.getHandler(), ctx.getClass(),
    ]);
    if (!required?.length) return true;   // no role restriction

    const { user } = ctx.switchToHttp().getRequest();
    if (!required.includes(user.role)) {
      throw new ForbiddenException("You do not have permission to access this resource");
    }
    return true;
  }
}

/**
 * Scanner-specific guard.
 * Verifies that the authenticated staff member is assigned to the ride they are scanning.
 * NOTE: The actual ticket-to-ride match is checked inside TicketsService.redeem().
 * This guard only verifies the JWT's assignedRideId claim, providing a first line of defence.
 */
@Injectable()
export class ScannerRideGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req  = ctx.switchToHttp().getRequest();
    const user = req.user;
    if (!user?.assignedRideId) {
      throw new ForbiddenException("No ride assignment found in token");
    }
    // The staff member is only allowed to POST to /staff/scan — body.rideId must match token
    if (req.body?.rideId && req.body.rideId !== user.assignedRideId) {
      throw new ForbiddenException("You can only scan tickets for your assigned ride");
    }
    return true;
  }
}

/**
 * Same idea as ScannerRideGuard, for staff assigned to a standalone Event
 * instead of a Fair's ride (see EventEntity / StaffEntity.assignedEvent).
 */
@Injectable()
export class ScannerEventGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req  = ctx.switchToHttp().getRequest();
    const user = req.user;
    if (!user?.assignedEventId) {
      throw new ForbiddenException("No event assignment found in token");
    }
    if (req.body?.eventId && req.body.eventId !== user.assignedEventId) {
      throw new ForbiddenException("You can only scan tickets for your assigned event");
    }
    return true;
  }
}

// ── CurrentUser decorator ─────────────────────────────────────────────────────
export const CurrentUser = createParamDecorator(
  (data: keyof JwtPayload | undefined, ctx: ExecutionContext) => {
    const user = ctx.switchToHttp().getRequest().user;
    return data ? user?.[data] : user;
  },
);

// ── Public decorator (skip JWT guard) ────────────────────────────────────────
export const IS_PUBLIC_KEY = "isPublic";
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
