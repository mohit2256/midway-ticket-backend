// ── DTOs ──────────────────────────────────────────────────────────────────────
import { IsEmail, IsString, MinLength, IsEnum, IsOptional } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { UserRole } from "../entities";

export class RegisterDto {
  @ApiProperty() @IsString()  name:     string;
  @ApiProperty() @IsEmail()   email:    string;
  @ApiProperty() @IsString() @MinLength(8) password: string;
  @ApiProperty({ required: false }) @IsString() @IsOptional() phone?: string;
}

// Separate from RegisterDto: operator signup also needs a business/fair name
// up front, because creating an OPERATOR_OWNER user with nowhere to attach
// their OperatorEntity would leave them unable to create fairs afterwards
// (fairs.module.ts looks up the operator via `owner: { id: userId }`).
export class RegisterOperatorDto {
  @ApiProperty() @IsString()  name:         string;   // owner's own name
  @ApiProperty() @IsEmail()   email:        string;
  @ApiProperty() @IsString() @MinLength(8) password: string;
  @ApiProperty({ required: false }) @IsString() @IsOptional() phone?: string;
  @ApiProperty({ description: "Business / fair operator name, e.g. 'Grand City Mela Events'" })
  @IsString() businessName: string;
}

export class LoginDto {
  @ApiProperty() @IsEmail()  email:    string;
  @ApiProperty() @IsString() password: string;
}

export class VerifyEmailDto {
  @ApiProperty() @IsString() token: string;
}

export class ResendVerificationDto {
  @ApiProperty() @IsEmail() email: string;
}

export class ForgotPasswordDto {
  @ApiProperty() @IsEmail() email: string;
}

export class ResetPasswordDto {
  @ApiProperty() @IsString() token: string;
  @ApiProperty() @IsString() @MinLength(8) newPassword: string;
}

// ── Service ───────────────────────────────────────────────────────────────────
import { Injectable, ConflictException, UnauthorizedException, BadRequestException, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { TicketEmailService } from "../email/ticket-email.service";
import * as bcrypt from "bcrypt";
import * as crypto from "crypto";
import { UserEntity, StaffEntity, OperatorEntity } from "../entities";
import type { JwtPayload } from "../../common/guards/auth.guards";

// How long a verification/reset link stays valid before the user has to
// request a fresh one.
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const RESET_TTL_MS        = 60 * 60 * 1000;      // 1h

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(UserEntity)     private readonly users:     Repository<UserEntity>,
    @InjectRepository(StaffEntity)    private readonly staff:     Repository<StaffEntity>,
    @InjectRepository(OperatorEntity) private readonly operators: Repository<OperatorEntity>,
    private readonly ticketEmail:      TicketEmailService,
    private readonly jwtService: JwtService,
    private readonly config:     ConfigService,
  ) {}

  async register(dto: RegisterDto) {
    const exists = await this.users.findOne({ where: { email: dto.email } });
    if (exists) throw new ConflictException("Email already registered");

    const user = this.users.create({
      name:         dto.name,
      email:        dto.email,
      phone:        dto.phone,
      passwordHash: await bcrypt.hash(dto.password, 12),
      role:         UserRole.CUSTOMER,
    });
    await this.users.save(user);
    await this.sendVerificationEmail(user);

    // Registration still logs the user in immediately — verification is a
    // background nudge (banner + resend option on the frontend), not a hard
    // gate, so this doesn't change existing behaviour for anyone.
    return this.issueTokens(user);
  }

  /**
   * Operator signup. Previously there was no way to create an operator
   * account at all — the only public register endpoint hardcoded
   * UserRole.CUSTOMER. This creates the User (role OPERATOR_OWNER) AND its
   * linked OperatorEntity in one step, since fairs.module.ts requires an
   * OperatorEntity row to exist before an operator can create a fair.
   */
  async registerOperator(dto: RegisterOperatorDto) {
    const exists = await this.users.findOne({ where: { email: dto.email } });
    if (exists) throw new ConflictException("Email already registered");

    const user = this.users.create({
      name:         dto.name,
      email:        dto.email,
      phone:        dto.phone,
      passwordHash: await bcrypt.hash(dto.password, 12),
      role:         UserRole.OPERATOR_OWNER,
    });
    await this.users.save(user);

    const operator = this.operators.create({
      name:  dto.businessName,
      owner: user,
    });
    await this.operators.save(operator);
    await this.sendVerificationEmail(user);

    return this.issueTokens(user);
  }

  // ── Email verification ───────────────────────────────────────────────────

  private async sendVerificationEmail(user: UserEntity) {
    const token = crypto.randomBytes(32).toString("hex");
    user.emailVerificationTokenHash  = sha256(token);
    user.emailVerificationExpiresAt  = new Date(Date.now() + VERIFICATION_TTL_MS);
    await this.users.save(user);

    const verifyUrl = `${this.config.get("app.frontendUrl")}/verify-email?token=${token}`;
    // FIX: was queued through the same Redis-backed BullMQ "email" queue as
    // ticket emails — unreachable in production, so verification emails
    // were silently never sent either. TicketEmailService sends directly
    // and never throws (bounded internally), so this still can't hang or
    // fail signup even on a bad SMTP day.
    await this.ticketEmail.sendVerificationEmail({ email: user.email, name: user.name, verifyUrl });
  }

  async verifyEmail(dto: VerifyEmailDto) {
    const tokenHash = sha256(dto.token);
    const user = await this.users
      .createQueryBuilder("u")
      .addSelect("u.emailVerificationTokenHash")
      .where("u.emailVerificationTokenHash = :tokenHash", { tokenHash })
      .getOne();

    if (!user || !user.emailVerificationExpiresAt || user.emailVerificationExpiresAt < new Date()) {
      throw new BadRequestException("This verification link is invalid or has expired. Request a new one.");
    }

    user.emailVerified = true;
    user.emailVerificationTokenHash = null as any;
    user.emailVerificationExpiresAt = null as any;
    await this.users.save(user);

    return { verified: true };
  }

  async resendVerification(dto: ResendVerificationDto) {
    const user = await this.users.findOne({ where: { email: dto.email } });
    // Deliberately the same response whether or not the account exists, or
    // is already verified — same user-enumeration reasoning as
    // forgotPassword() below.
    if (user && !user.emailVerified) {
      await this.sendVerificationEmail(user);
    }
    return { message: "If that account exists and isn't verified yet, a new verification email has been sent." };
  }

  // ── Password reset ───────────────────────────────────────────────────────

  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.users.findOne({ where: { email: dto.email } });

    // CRITICAL: always return the exact same response whether or not the
    // email exists. Returning something different ("email not found" vs
    // "reset link sent") lets an attacker enumerate every registered email
    // address on the platform one guess at a time.
    const genericResponse = { message: "If that email is registered, a password reset link has been sent." };
    if (!user) return genericResponse;

    const token = crypto.randomBytes(32).toString("hex");
    user.passwordResetTokenHash = sha256(token);
    user.passwordResetExpiresAt = new Date(Date.now() + RESET_TTL_MS);
    await this.users.save(user);

    const resetUrl = `${this.config.get("app.frontendUrl")}/reset-password?token=${token}`;
    await this.ticketEmail.sendPasswordResetEmail({ email: user.email, name: user.name, resetUrl });

    return genericResponse;
  }

  async resetPassword(dto: ResetPasswordDto) {
    const tokenHash = sha256(dto.token);
    const user = await this.users
      .createQueryBuilder("u")
      .addSelect("u.passwordResetTokenHash")
      .where("u.passwordResetTokenHash = :tokenHash", { tokenHash })
      .getOne();

    if (!user || !user.passwordResetExpiresAt || user.passwordResetExpiresAt < new Date()) {
      throw new BadRequestException("This reset link is invalid or has expired. Request a new one.");
    }

    user.passwordHash            = await bcrypt.hash(dto.newPassword, 12);
    user.passwordResetTokenHash  = null as any;
    user.passwordResetExpiresAt  = null as any;
    // Kills every JWT issued before this moment — see JwtStrategy.validate().
    user.passwordChangedAt       = new Date();
    await this.users.save(user);

    return { message: "Your password has been reset. Please log in with your new password." };
  }

  async loginCustomer(dto: LoginDto) {
    return this.loginWithRole(dto, [UserRole.CUSTOMER]);
  }

  async loginOperator(dto: LoginDto) {
    return this.loginWithRole(dto, [UserRole.OPERATOR_OWNER, UserRole.OPERATOR_MANAGER]);
  }

  /**
   * Staff login — resolves the staff member's ride assignment and encodes it
   * directly into the JWT payload so downstream guards can check it without
   * a database round-trip on every scan request.
   *
   * IMPORTANT: The JWT claims are still re-verified on every scan in TicketsService
   * to ensure they haven't been tampered with.
   */
  async loginStaff(dto: LoginDto) {
    const user = await this.loginWithRole(dto, [UserRole.SCANNER_STAFF]);

    // Load staff assignment — either a Fair's ride, or a standalone Event.
    const staffMember = await this.staff.findOne({
      where: { user: { id: user.userId }, isActive: true },
      relations: ["assignedRide", "fair", "assignedEvent", "operator"],
    });
    if (!staffMember) throw new UnauthorizedException("No active staff assignment found");

    if (staffMember.assignedEvent) {
      const payload: JwtPayload = {
        sub:             user.userId,
        email:           user.email,
        role:            UserRole.SCANNER_STAFF,
        staffId:         staffMember.id,
        assignedEventId: staffMember.assignedEvent.id,
      };
      return {
        accessToken:   this.jwtService.sign(payload, { expiresIn: "12h" }),
        staffId:       staffMember.id,
        assignedEvent: { id: staffMember.assignedEvent.id, name: staffMember.assignedEvent.name },
        gate:          staffMember.gate,
      };
    }

    // Issue a token that includes the ride assignment
    const payload: JwtPayload = {
      sub:             user.userId,
      email:           user.email,
      role:            UserRole.SCANNER_STAFF,
      staffId:         staffMember.id,
      assignedRideId:  staffMember.assignedRide.id,
      assignedFairId:  staffMember.fair.id,
    };

    return {
      accessToken:   this.jwtService.sign(payload, { expiresIn: "12h" }),
      staffId:       staffMember.id,
      assignedRide:  { id: staffMember.assignedRide.id, name: staffMember.assignedRide.name },
      assignedFair:  { id: staffMember.fair.id, name: staffMember.fair.name },
      gate:          staffMember.gate,
    };
  }

  private async loginWithRole(dto: LoginDto, allowedRoles: UserRole[]) {
    const user = await this.users
      .createQueryBuilder("u")
      .addSelect("u.passwordHash")
      .where("u.email = :email", { email: dto.email })
      .getOne();

    if (!user || !allowedRoles.includes(user.role)) {
      throw new UnauthorizedException("Invalid credentials");
    }
    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) throw new UnauthorizedException("Invalid credentials");
    if (!user.isActive) throw new UnauthorizedException("Account is disabled");

    return this.issueTokens(user);
  }

  /**
   * Issue JWT tokens and return a complete auth payload.
   * operatorId is resolved here so that the frontend never needs a follow-up
   * fairs lookup (which fails for brand-new operators who have 0 fairs yet).
   */
  private async issueTokens(user: UserEntity) {
    const payload: JwtPayload = { sub: user.id, email: user.email, role: user.role };

    let operatorId = "";
    let operatorName = "";
    if (
      user.role === UserRole.OPERATOR_OWNER ||
      user.role === UserRole.OPERATOR_MANAGER
    ) {
      const op = await this.operators.findOne({ where: { owner: { id: user.id } } });
      operatorId   = op?.id ?? "";
      operatorName = op?.name ?? "";
    }

    return {
      accessToken: this.jwtService.sign(payload),
      userId:      user.id,
      email:       user.email,
      name:        user.name,
      role:        user.role,
      operatorId,             // empty string for customers/staff — never null
      operatorName,           // the OperatorEntity's business name, not the owner's personal name
      emailVerified: user.emailVerified,
    };
  }
}

// ── Controller ────────────────────────────────────────────────────────────────
import { Controller, Post, Body, HttpCode, HttpStatus } from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";

@ApiTags("auth")
@Controller({ path: "auth", version: "1" })
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post("register")
  @ApiOperation({ summary: "Register a new customer account" })
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post("register/operator")
  @ApiOperation({ summary: "Register a new operator account (creates the operator's business profile too)" })
  registerOperator(@Body() dto: RegisterOperatorDto) {
    return this.authService.registerOperator(dto);
  }

  @Post("login/customer")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Customer login" })
  loginCustomer(@Body() dto: LoginDto) {
    return this.authService.loginCustomer(dto);
  }

  @Post("login/operator")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Operator login" })
  loginOperator(@Body() dto: LoginDto) {
    return this.authService.loginOperator(dto);
  }

  @Post("login/staff")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Scanner staff login — returns ride assignment in response" })
  loginStaff(@Body() dto: LoginDto) {
    return this.authService.loginStaff(dto);
  }

  @Post("verify-email")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Verify an account's email address using the token from the verification email" })
  verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.authService.verifyEmail(dto);
  }

  @Post("resend-verification")
  @HttpCode(HttpStatus.OK)
  // Tighter than the global default — this endpoint sends an email per
  // call, so it's a spam/cost vector if left at the general request limit.
  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  @ApiOperation({ summary: "Resend the email verification link" })
  resendVerification(@Body() dto: ResendVerificationDto) {
    return this.authService.resendVerification(dto);
  }

  @Post("forgot-password")
  @HttpCode(HttpStatus.OK)
  // Same reasoning as resend-verification — this is exactly the kind of
  // endpoint that gets hammered to spam other people's inboxes or to probe
  // which emails are registered, so it gets its own tighter limit.
  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  @ApiOperation({ summary: "Request a password reset email" })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Post("reset-password")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @ApiOperation({ summary: "Reset password using the token from the reset email" })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }
}

// ── Module ────────────────────────────────────────────────────────────────────
import { Module } from "@nestjs/common";
import { PassportModule } from "@nestjs/passport";
import { JwtModule } from "@nestjs/jwt";
import { TypeOrmModule } from "@nestjs/typeorm";
import { EmailModule } from "../email/email.module";
import { JwtStrategy } from "../../common/guards/auth.guards";

@Module({
  imports: [
    TypeOrmModule.forFeature([UserEntity, StaffEntity, OperatorEntity]),
    PassportModule.register({ defaultStrategy: "jwt" }),
    EmailModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        secret:     cfg.get("app.jwt.secret", "change-me"),
        signOptions: { expiresIn: cfg.get("app.jwt.expiresIn", "7d") },
      }),
    }),
  ],
  controllers: [AuthController],
  providers:   [AuthService, JwtStrategy],
  exports:     [AuthService, JwtModule],
})
export class AuthModule {}
