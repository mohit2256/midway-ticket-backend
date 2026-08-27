import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { IsString, IsOptional } from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { Controller, Get, Patch, Body, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { UserEntity } from "../entities";
import { JwtAuthGuard, CurrentUser } from "../../common/guards/auth.guards";

class UpdateProfileDto {
  @ApiPropertyOptional() @IsString() @IsOptional() name?: string;
  @ApiPropertyOptional() @IsString() @IsOptional() phone?: string;
}

@Injectable()
class UsersService {
  constructor(@InjectRepository(UserEntity) private users: Repository<UserEntity>) {}
  async getProfile(id: string) {
    const u = await this.users.findOne({ where: { id } });
    if (!u) throw new NotFoundException("User not found");
    return u;
  }
  async updateProfile(id: string, dto: UpdateProfileDto) {
    const u = await this.users.findOne({ where: { id } });
    if (!u) throw new NotFoundException("User not found");
    Object.assign(u, dto);
    return this.users.save(u);
  }
}

@ApiTags("users")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: "users", version: "1" })
class UsersController {
  constructor(private readonly svc: UsersService) {}
  @Get("me") getMe(@CurrentUser("sub") id: string) { return this.svc.getProfile(id); }
  @Patch("me") update(@Body() dto: UpdateProfileDto, @CurrentUser("sub") id: string) { return this.svc.updateProfile(id, dto); }
}

@Module({
  imports: [TypeOrmModule.forFeature([UserEntity])],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
