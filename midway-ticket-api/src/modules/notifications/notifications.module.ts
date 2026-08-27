// ═══════════════════════════════════════════════════════════════════════════════
// NOTIFICATIONS MODULE — queue-based, eventual consistency by design.
//
// Flow:
//   Bookings/Tickets service → notifications.enqueue(...)  [fire-and-forget]
//        → BullMQ "notifications" queue
//        → NotificationsProcessor (separate worker context)
//              1. writes a NotificationEntity row (status PENDING → SENT)
//              2. pushes it over the RealtimeGateway to the recipient's room
//
// Why a queue instead of writing the row inline in the booking/scan transaction:
// notification delivery (in-app push, later: email/SMS/push-notification
// providers) can be slow or flaky. It must never be able to fail or slow down
// the ticket purchase / scan — those need strong consistency and low latency.
// Notifications are allowed to arrive a few hundred ms late (eventual
// consistency) in exchange for never blocking the critical path.
// ═══════════════════════════════════════════════════════════════════════════════

import { Injectable, Logger, Module } from "@nestjs/common";
import { InjectQueue, Processor, WorkerHost, BullModule } from "@nestjs/bullmq";
import { Queue, Job } from "bullmq";
import { InjectRepository, TypeOrmModule } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import {
  Controller, Get, Patch, Param, UseGuards, Query,
} from "@nestjs/common";
import { ApiTags, ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { NotificationEntity, NotificationType, NotificationChannel, NotificationStatus } from "../entities";
import { JwtAuthGuard, CurrentUser } from "../../common/guards/auth.guards";
import { RealtimeGateway } from "../realtime/realtime.gateway";

// ── Job payload shape enqueued by other modules ────────────────────────────────
export interface NotificationJob {
  type:              NotificationType;
  channel?:          NotificationChannel;      // defaults to IN_APP
  recipientUserId?:  string;
  recipientOperatorId?: string;
  fairId?:           string;                   // used to route the WS room
  payload:           Record<string, unknown>;
}

// ── Service — what other modules call ──────────────────────────────────────────
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectQueue("notifications") private queue: Queue,
    @InjectRepository(NotificationEntity) private repo: Repository<NotificationEntity>,
  ) {}

  /** Fire-and-forget. Never throws into the caller's transaction. */
  async enqueue(job: NotificationJob) {
    await this.queue.add("dispatch", job, {
      attempts: 3,
      backoff:  { type: "exponential", delay: 2000 },
    }).catch((err) => {
      this.logger.error("Failed to enqueue notification (non-fatal)", err);
    });
  }

  async getForUser(userId: string, unreadOnly = false) {
    return this.repo.find({
      where: unreadOnly
        ? { recipientUser: { id: userId }, isRead: false }
        : { recipientUser: { id: userId } },
      order: { createdAt: "DESC" },
      take:  50,
    });
  }

  async markRead(id: string) {
    await this.repo.update({ id }, { isRead: true });
    return { ok: true };
  }
}

// ── Worker — runs off the request path ─────────────────────────────────────────
@Processor("notifications")
export class NotificationsProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationsProcessor.name);

  constructor(
    @InjectRepository(NotificationEntity) private repo: Repository<NotificationEntity>,
    private readonly realtime: RealtimeGateway,
  ) {
    super();
  }

  async process(job: Job<NotificationJob>) {
    const data = job.data;
    const notification = this.repo.create({
      type:              data.type,
      channel:           data.channel ?? NotificationChannel.IN_APP,
      status:            NotificationStatus.PENDING,
      recipientUser:     data.recipientUserId ? ({ id: data.recipientUserId } as any) : undefined,
      recipientOperator: data.recipientOperatorId ? ({ id: data.recipientOperatorId } as any) : undefined,
      payload:           data.payload,
    });
    await this.repo.save(notification);

    // Push over WebSocket if we know which room to target — best-effort,
    // in-app notification list (via GET /notifications) is the durable copy.
    if (data.fairId) {
      this.realtime.emitDashboardUpdate(data.recipientOperatorId ?? "unknown", {
        type: data.type,
        ...data.payload,
      });
    }

    notification.status = NotificationStatus.SENT;
    notification.sentAt = new Date();
    await this.repo.save(notification);

    this.logger.log(`Notification dispatched: ${data.type}`);
  }
}

// ── Controller — in-app notification list for the logged-in user ──────────────
@ApiTags("notifications")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: "notifications", version: "1" })
class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: "List my in-app notifications" })
  list(@CurrentUser("sub") userId: string, @Query("unread") unread?: string) {
    return this.svc.getForUser(userId, unread === "true");
  }

  @Patch(":id/read")
  @ApiOperation({ summary: "Mark a notification as read" })
  markRead(@Param("id") id: string) {
    return this.svc.markRead(id);
  }
}

// ── Module ──────────────────────────────────────────────────────────────────────
@Module({
  imports: [
    TypeOrmModule.forFeature([NotificationEntity]),
    BullModule.registerQueue({ name: "notifications" }),
  ],
  controllers: [NotificationsController],
  providers:   [NotificationsService, NotificationsProcessor],
  exports:     [NotificationsService],
})
export class NotificationsModule {}
