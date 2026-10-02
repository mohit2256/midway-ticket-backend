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

// Kept working for backward compatibility with any existing password-based
// operator accounts — the operator LOGIN screen itself now only offers
// Google sign-in (see googleAuthOperator below), but this endpoint isn't
// deleted so a support/recovery path still exists if ever needed.
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

// Verified entirely server-side by google-auth-library against Google's own
// public keys — the ID token itself is the only thing trusted here. Nothing
// else the client sends about "who they are" is ever used for role or
// identity decisions.
export class GoogleAuthDto {
  @ApiProperty() @IsString() idToken: string;
}

export class MagicLinkRequestDto {
  @ApiProperty() @IsEmail() email: string;
}

export class MagicLinkVerifyDto {
  @ApiProperty() @IsString() token: string;
}

export class CompleteOperatorProfileDto {
  @ApiProperty({ description: "Business / fair operator name, e.g. 'Grand City Mela Events'" })
  @IsString() businessName: string;
}

// ── Service ───────────────────────────────────────────────────────────────────
import { Injectable, ConflictException, UnauthorizedException, ForbiddenException, BadRequestException, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { TicketEmailService } from "../email/ticket-email.service";
import * as bcrypt from "bcrypt";
import * as crypto from "crypto";
import { OAuth2Client } from "google-auth-library";
import { UserEntity, StaffEntity, OperatorEntity } from "../entities";
import type { JwtPayload } from "../../common/guards/auth.guards";

// How long a verification/reset/magic-link link stays valid before the user
// has to request a fresh one.
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const RESET_TTL_MS        = 60 * 60 * 1000;      // 1h
const MAGIC_LINK_TTL_MS   = 30 * 60 * 1000;      // 30m — shorter than email verification since it's also a login credential

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly googleClient: OAuth2Client;

  constructor(
    @InjectRepository(UserEntity)     private readonly users:     Repository<UserEntity>,
    @InjectRepository(StaffEntity)    private readonly staff:     Repository<StaffEntity>,
    @InjectRepository(OperatorEntity) private readonly operators: Repository<OperatorEntity>,
    private readonly ticketEmail: TicketEmailService,
    private readonly jwtService: JwtService,
    private readonly config:     ConfigService,
  ) {
    this.googleClient = new OAuth2Client(this.config.get("app.google.clientId"));
  }

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
   * Operator signup via email+password. Kept working (see RegisterOperatorDto
   * comment above) but no longer linked from the operator login screen —
   * googleAuthOperator() below is the primary path now.
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

  // ── Google sign-in ────────────────────────────────────────────────────────
  //
  // Two separate methods/endpoints (customer vs operator) rather than one
  // endpoint with a client-supplied "intent" field — the ENDPOINT itself is
  // what determines which role a new account gets, so a tampered request
  // body can never be used to self-assign a role. Google only ever proves
  // "this really is <verified-email>" — nothing more.

  async googleAuthCustomer(dto: GoogleAuthDto) {
    const payload = await this.verifyGoogleToken(dto.idToken);
    const user = await this.findOrCreateGoogleUser(payload, UserRole.CUSTOMER);
    return this.issueTokens(user);
  }

  async googleAuthOperator(dto: GoogleAuthDto) {
    const payload = await this.verifyGoogleToken(dto.idToken);
    const user = await this.findOrCreateGoogleUser(payload, UserRole.OPERATOR_OWNER);

    const operator = await this.operators.findOne({ where: { owner: { id: user.id } } });
    const tokens = await this.issueTokens(user);
    // Brand-new operator: no business profile yet. The frontend checks this
    // flag and routes to a one-time "tell us about your business" step
    // before landing on the dashboard — OperatorEntity.name has no
    // reasonable default, Google never provides a business name.
    return { ...tokens, needsOnboarding: !operator };
  }

  private async verifyGoogleToken(idToken: string) {
    const clientId = this.config.get<string>("app.google.clientId");
    if (!clientId) {
      throw new BadRequestException("Google sign-in isn't configured on this server yet.");
    }
    let ticket;
    try {
      ticket = await this.googleClient.verifyIdToken({ idToken, audience: clientId });
    } catch (err) {
      this.logger.warn(`Google ID token verification failed: ${(err as Error).message}`);
      throw new UnauthorizedException("Couldn't verify your Google sign-in. Please try again.");
    }
    const payload = ticket.getPayload();
    if (!payload?.email) {
      throw new UnauthorizedException("Google didn't return an email address for this account.");
    }
    if (!payload.email_verified) {
      throw new UnauthorizedException("Your Google email isn't verified. Please verify it with Google first.");
    }
    return payload;
  }

  private async findOrCreateGoogleUser(
    payload: { sub: string; email: string; name?: string },
    intendedRole: UserRole,
  ): Promise<UserEntity> {
    // Fast path: this Google account has signed in here before.
    let user = await this.users.findOne({ where: { googleId: payload.sub } });
    if (user) return user;

    // Slower path: an account with this email exists, but was never linked
    // to Google — e.g. a guest-checkout customer, or a pre-existing
    // password-based operator account. Link it rather than creating a
    // duplicate, so any tickets/fairs already tied to that user id carry
    // straight over.
    user = await this.users.findOne({ where: { email: payload.email } });
    if (user) {
      if (user.role !== intendedRole) {
        // Never silently reassign a role via Google — that decision stays
        // with the backend, and an email collision across roles is exactly
        // the case where a human needs to sort it out, not this code.
        throw new ConflictException(
          `This email is already registered as a ${roleLabel(user.role)} account. Please use the matching sign-in.`,
        );
      }
      user.googleId       = payload.sub;
      user.emailVerified  = true;
      if (payload.name && !user.name) user.name = payload.name;
      await this.users.save(user);
      return user;
    }

    // Brand new account.
    user = this.users.create({
      name:         payload.name || payload.email.split("@")[0],
      email:        payload.email,
      googleId:     payload.sub,
      role:         intendedRole,
      emailVerified: true, // Google already verified it — no need to re-verify
      passwordHash: null as any,
    });
    return this.users.save(user);
  }

  async completeOperatorProfile(userId: string, dto: CompleteOperatorProfileDto) {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user || user.role !== UserRole.OPERATOR_OWNER) {
      throw new ForbiddenException("Only operator accounts can set up a business profile.");
    }
    const existing = await this.operators.findOne({ where: { owner: { id: userId } } });
    if (existing) {
      return { operatorId: existing.id, operatorName: existing.name };
    }
    const operator = this.operators.create({ name: dto.businessName, owner: user });
    await this.operators.save(operator);
    return { operatorId: operator.id, operatorName: operator.name };
  }

  // ── Email verification ───────────────────────────────────────────────────

  private async sendVerificationEmail(user: UserEntity) {
    const token = crypto.randomBytes(32).toString("hex");
    user.emailVerificationTokenHash  = sha256(token);
    user.emailVerificationExpiresAt  = new Date(Date.now() + VERIFICATION_TTL_MS);
    await this.users.save(user);

    const verifyUrl = `${this.config.get("app.frontendUrl")}/verify-email?token=${token}`;
    // Sent directly (no queue) — see ticket-email.service.ts for why:
    // Redis-backed BullMQ was silently losing emails in this deployment.
    // A failed send is logged but never blocks registration itself.
    const sent = await this.ticketEmail.sendVerificationEmail({ email: user.email, name: user.name, verifyUrl });
    if (!sent) this.logger.warn(`Verification email did not send for ${user.email}`);
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
    if (user && !user.emailVerified) {
      await this.sendVerificationEmail(user);
    }
    return { message: "If that account exists and isn't verified yet, a new verification email has been sent." };
  }

  // ── Magic link ("My Tickets") ────────────────────────────────────────────
  //
  // Deliberately reuses the SAME emailVerificationTokenHash/ExpiresAt
  // columns as the verify-email flow above — a magic link IS an email
  // ownership proof, just one that also logs the person in. No separate
  // schema needed for what's conceptually the same primitive.

  async requestMagicLink(dto: MagicLinkRequestDto) {
    const user = await this.users.findOne({ where: { email: dto.email } });
    const genericResponse = { message: "If that email has any tickets, we've sent a link to view them." };
    if (!user) return genericResponse; // never confirm/deny which emails exist

    const token = crypto.randomBytes(32).toString("hex");
    user.emailVerificationTokenHash = sha256(token);
    user.emailVerificationExpiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS);
    await this.users.save(user);

    const magicLinkUrl = `${this.config.get("app.frontendUrl")}/tickets/verify?token=${token}`;
    const sent = await this.ticketEmail.sendMagicLinkEmail({ email: user.email, name: user.name, magicLinkUrl });
    if (!sent) this.logger.warn(`Magic link email did not send for ${user.email}`);

    return genericResponse;
  }

  async verifyMagicLink(dto: MagicLinkVerifyDto) {
    const tokenHash = sha256(dto.token);
    const user = await this.users
      .createQueryBuilder("u")
      .addSelect("u.emailVerificationTokenHash")
      .where("u.emailVerificationTokenHash = :tokenHash", { tokenHash })
      .getOne();

    if (!user || !user.emailVerificationExpiresAt || user.emailVerificationExpiresAt < new Date()) {
      throw new BadRequestException("This link is invalid or has expired. Request a new one.");
    }

    user.emailVerified = true; // clicking the link IS the ownership proof
    user.emailVerificationTokenHash = null as any;
    user.emailVerificationExpiresAt = null as any;
    await this.users.save(user);

    return this.issueTokens(user);
  }

  // ── Password reset ───────────────────────────────────────────────────────

  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.users.findOne({ where: { email: dto.email } });

    // CRITICAL: always return the exact same response whether or not the
    // email exists — returning something different lets an attacker
    // enumerate every registered email address on the platform.
    const genericResponse = { message: "If that email is registered, a password reset link has been sent." };
    if (!user) return genericResponse;
    if (!user.passwordHash) {
      // Google-only account — there's no password to reset. Silently no-op
      // rather than revealing this distinction (same enumeration reasoning).
      return genericResponse;
    }

    const token = crypto.randomBytes(32).toString("hex");
    user.passwordResetTokenHash = sha256(token);
    user.passwordResetExpiresAt = new Date(Date.now() + RESET_TTL_MS);
    await this.users.save(user);

    const resetUrl = `${this.config.get("app.frontendUrl")}/reset-password?token=${token}`;
    const sent = await this.ticketEmail.sendPasswordResetEmail({ email: user.email, name: user.name, resetUrl });
    if (!sent) this.logger.warn(`Password reset email did not send for ${user.email}`);

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
   * to ensure they haven't been tampered with. Deliberately unchanged as part
   * of this rework — staff/scanner auth stays exactly as it was.
   */
  async loginStaff(dto: LoginDto) {
    const user = await this.loginWithRole(dto, [UserRole.SCANNER_STAFF]);

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
    if (!user.passwordHash) {
      throw new UnauthorizedException("This account uses Google sign-in. Please use 'Sign in with Google' instead.");
    }
    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) throw new UnauthorizedException("Invalid credentials");
    if (!user.isActive) throw new UnauthorizedException("Account is disabled");

    return this.issueTokens(user);
  }

  /** GET /auth/me — re-derive the current session's user info fresh from the DB. */
  async getMe(userId: string) {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user || !user.isActive) throw new UnauthorizedException("Session is no longer valid");
    return this.issueTokens(user, /* includeToken */ false);
  }

  /**
   * Issue JWT tokens and return a complete auth payload.
   * operatorId is resolved here so that the frontend never needs a follow-up
   * fairs lookup (which fails for brand-new operators who have 0 fairs yet).
   */
  private async issueTokens(user: UserEntity, includeToken = true) {
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
      ...(includeToken ? { accessToken: this.jwtService.sign(payload) } : {}),
      userId:      user.id,
      email:       user.email,
      name:        user.name,
      role:        user.role,
      operatorId,             // empty string for customers/staff — never null
      operatorName,           // the OperatorEntity's business name, not the owner's personal name
      emailVerified: user.emailVerified,
      hasGoogleLinked: Boolean(user.googleId),
    };
  }
}

function roleLabel(role: UserRole): string {
  switch (role) {
    case UserRole.OPERATOR_OWNER:
    case UserRole.OPERATOR_MANAGER: return "operator";
    case UserRole.SCANNER_STAFF:    return "staff";
    default:                        return "customer";
  }
}

// ── Controller ────────────────────────────────────────────────────────────────
import { Controller, Post, Get, Body, HttpCode, HttpStatus, UseGuards } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { JwtAuthGuard, CurrentUser } from "../../common/guards/auth.guards";

@ApiTags("auth")
@Controller({ path: "auth", version: "1" })
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post("register")
  @ApiOperation({ summary: "Register a new customer account (password-based)" })
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post("register/operator")
  @ApiOperation({ summary: "[Legacy/backup path] Register a new operator account with a password" })
  registerOperator(@Body() dto: RegisterOperatorDto) {
    return this.authService.registerOperator(dto);
  }

  @Post("login/customer")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Customer login (password-based)" })
  loginCustomer(@Body() dto: LoginDto) {
    return this.authService.loginCustomer(dto);
  }

  @Post("login/operator")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "[Legacy/backup path] Operator login (password-based)" })
  loginOperator(@Body() dto: LoginDto) {
    return this.authService.loginOperator(dto);
  }

  @Post("login/staff")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Scanner staff login — returns ride/event assignment in response" })
  loginStaff(@Body() dto: LoginDto) {
    return this.authService.loginStaff(dto);
  }

  @Post("google/customer")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Sign in (or link/create) a customer account via a verified Google ID token" })
  googleAuthCustomer(@Body() dto: GoogleAuthDto) {
    return this.authService.googleAuthCustomer(dto);
  }

  @Post("google/operator")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Sign in (or link/create) an operator account via a verified Google ID token" })
  googleAuthOperator(@Body() dto: GoogleAuthDto) {
    return this.authService.googleAuthOperator(dto);
  }

  @Post("operator/complete-profile")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: "First-time-only: set the business name for a Google-created operator account" })
  completeOperatorProfile(@Body() dto: CompleteOperatorProfileDto, @CurrentUser("sub") userId: string) {
    return this.authService.completeOperatorProfile(userId, dto);
  }

  @Get("me")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: "Re-derive the current session's user info fresh from the database" })
  me(@CurrentUser("sub") userId: string) {
    return this.authService.getMe(userId);
  }

  @Post("verify-email")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Verify an account's email address using the token from the verification email" })
  verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.authService.verifyEmail(dto);
  }

  @Post("resend-verification")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  @ApiOperation({ summary: "Resend the email verification link" })
  resendVerification(@Body() dto: ResendVerificationDto) {
    return this.authService.resendVerification(dto);
  }

  @Post("magic-link/request")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  @ApiOperation({ summary: "'My Tickets': email a sign-in link for the given address" })
  requestMagicLink(@Body() dto: MagicLinkRequestDto) {
    return this.authService.requestMagicLink(dto);
  }

  @Post("magic-link/verify")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: "'My Tickets': exchange a magic-link token for a login session" })
  verifyMagicLink(@Body() dto: MagicLinkVerifyDto) {
    return this.authService.verifyMagicLink(dto);
  }

  @Post("forgot-password")
  @HttpCode(HttpStatus.OK)
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
