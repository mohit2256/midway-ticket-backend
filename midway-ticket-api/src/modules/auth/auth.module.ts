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

// ── Service ───────────────────────────────────────────────────────────────────
import { Injectable, ConflictException, UnauthorizedException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import * as bcrypt from "bcrypt";
import { UserEntity, StaffEntity, OperatorEntity } from "../entities";
import type { JwtPayload } from "../../common/guards/auth.guards";

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(UserEntity)     private readonly users:     Repository<UserEntity>,
    @InjectRepository(StaffEntity)    private readonly staff:     Repository<StaffEntity>,
    @InjectRepository(OperatorEntity) private readonly operators: Repository<OperatorEntity>,
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

    return this.issueTokens(user);
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

    // Load staff assignment
    const staffMember = await this.staff.findOne({
      where: { user: { id: user.userId }, isActive: true },
      relations: ["assignedRide", "fair", "operator"],
    });
    if (!staffMember) throw new UnauthorizedException("No active staff assignment found");

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

  private issueTokens(user: UserEntity) {
    const payload: JwtPayload = { sub: user.id, email: user.email, role: user.role };
    return {
      accessToken:  this.jwtService.sign(payload),
      userId: user.id,
      email:  user.email,
      name:   user.name,
      role:   user.role,
    };
  }
}

// ── Controller ────────────────────────────────────────────────────────────────
import { Controller, Post, Body, HttpCode, HttpStatus } from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";

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
}

// ── Module ────────────────────────────────────────────────────────────────────
import { Module } from "@nestjs/common";
import { PassportModule } from "@nestjs/passport";
import { JwtModule } from "@nestjs/jwt";
import { TypeOrmModule } from "@nestjs/typeorm";
import { JwtStrategy } from "../../common/guards/auth.guards";

@Module({
  imports: [
    TypeOrmModule.forFeature([UserEntity, StaffEntity, OperatorEntity]),
    PassportModule.register({ defaultStrategy: "jwt" }),
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
