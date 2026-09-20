import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { TicketEntity } from "../entities";
import { TicketEmailService } from "./ticket-email.service";

@Module({
  imports:   [TypeOrmModule.forFeature([TicketEntity])],
  providers: [TicketEmailService],
  exports:   [TicketEmailService],
})
export class EmailModule {}
