import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Controller, Get, Post, Param, Body, Headers, UseGuards, HttpCode, HttpStatus, Logger } from "@nestjs/common";
import { ApiTags, ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { PaymentEntity, OperatorTransactionEntity } from "../entities";
import { JwtAuthGuard, CurrentUser } from "../../common/guards/auth.guards";

@Injectable()
export class PaymentsService {
  constructor(
    @InjectRepository(PaymentEntity) private payments: Repository<PaymentEntity>,
    @InjectRepository(OperatorTransactionEntity) private txns: Repository<OperatorTransactionEntity>,
  ) {}

  findByCustomer(customerId: string) {
    return this.payments.find({
      where: { customer: { id: customerId } },
      order: { createdAt: "DESC" },
      take: 20,
    });
  }

  findByOrder(orderId: string) {
    return this.payments.findOne({ where: { razorpayOrderId: orderId } });
  }

  /**
   * Placeholder — future operator payout webhook (Razorpay Route / RazorpayX
   * or similar). No signature verification, no state changes, no gateway
   * wired up. Exists only so the URL/route shape is reserved and the
   * frontend/ops docs can already reference it. DO NOT expose this in
   * production docs or point a real gateway at it until it's implemented —
   * right now it does nothing but log and 200.
   */
  async handlePayoutWebhookStub(payload: unknown) {
    Logger.warn(
      "Payout webhook stub hit — feature not implemented yet.",
      "PaymentsService",
    );
    return { received: true, note: "Payout feature not yet active." };
  }
}

@ApiTags("payments")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: "payments", version: "1" })
export class PaymentsController {
  constructor(private readonly svc: PaymentsService) {}

  @Get("mine")
  @ApiOperation({ summary: "Get payment history for current customer" })
  mine(@CurrentUser("sub") id: string) { return this.svc.findByCustomer(id); }

  @Get("order/:orderId")
  @ApiOperation({ summary: "Check payment status by Razorpay order ID" })
  byOrder(@Param("orderId") id: string) { return this.svc.findByOrder(id); }

  @Post("webhook")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "[Reserved / not implemented] Future operator payout webhook",
    description: "Placeholder route for the payouts feature. Currently a no-op stub.",
  })
  payoutWebhookStub(@Body() body: unknown, @Headers() headers: Record<string, string>) {
    return this.svc.handlePayoutWebhookStub(body);
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([PaymentEntity, OperatorTransactionEntity])],
  controllers: [PaymentsController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
