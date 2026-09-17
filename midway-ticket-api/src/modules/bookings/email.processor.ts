// ─────────────────────────────────────────────────────────────────────────────
// Email Queue Processor — sends ticket confirmation emails via BullMQ
// Uses SMTP (Resend / SendGrid / SMTP2Go in production)
// ─────────────────────────────────────────────────────────────────────────────

import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, In } from "typeorm";
import { Job } from "bullmq";
import { ConfigService } from "@nestjs/config";
import * as nodemailer from "nodemailer";
import * as QRCode from "qrcode";
import { TicketEntity } from "../entities";

export interface SendTicketJob {
  customerId: string;
  /** One email per purchase, one QR per ticket — every ticket from that purchase goes in here, not just one. */
  ticketIds: string[];
}

export interface SendVerificationEmailJob {
  email: string; name: string; verifyUrl: string;
}

export interface SendPasswordResetEmailJob {
  email: string; name: string; resetUrl: string;
}

@Processor("email")
export class EmailProcessor extends WorkerHost {
  private readonly logger     = new Logger(EmailProcessor.name);
  private readonly transporter: nodemailer.Transporter;

  constructor(
    @InjectRepository(TicketEntity) private tickets: Repository<TicketEntity>,
    private readonly config: ConfigService,
  ) {
    super();
    this.transporter = nodemailer.createTransport({
      host: config.get("app.smtp.host"),
      port: config.get("app.smtp.port", 587),
      auth: {
        user: config.get("app.smtp.user"),
        pass: config.get("app.smtp.pass"),
      },
    });
  }

  async process(job: Job) {
    switch (job.name) {
      case "send-ticket":                 return this.sendTicketEmail(job.data as SendTicketJob);
      case "send-verification-email":     return this.sendVerificationEmail(job.data as SendVerificationEmailJob);
      case "send-password-reset-email":   return this.sendPasswordResetEmail(job.data as SendPasswordResetEmailJob);
      default: this.logger.warn(`Unknown job: ${job.name}`);
    }
  }

  private async sendVerificationEmail({ email, name, verifyUrl }: SendVerificationEmailJob) {
    await this.transporter.sendMail({
      from:    this.config.get("app.smtp.from", "tickets@midwayticket.in"),
      to:      email,
      subject: "Verify your MidwayTicket email address",
      html: `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#F8FAFC;margin:0;padding:20px;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);">
    <div style="background:linear-gradient(135deg,#0F172A,#1E293B);padding:24px;text-align:center;">
      <div style="color:#38BDF8;font-size:12px;font-weight:700;letter-spacing:.1em;margin-bottom:4px;">MIDWAYTICKET</div>
      <div style="color:#fff;font-size:22px;font-weight:700;">Verify your email</div>
    </div>
    <div style="padding:24px;">
      <p style="color:#64748B;font-size:14px;">Hi ${name},<br>Confirm this is really your email address to finish setting up your account.</p>
      <div style="text-align:center;margin:24px 0;">
        <a href="${verifyUrl}" style="display:inline-block;background:#0EA5E9;color:#fff;font-weight:600;font-size:14px;padding:12px 28px;border-radius:10px;text-decoration:none;">Verify Email</a>
      </div>
      <p style="color:#94A3B8;font-size:12px;">This link expires in 24 hours. If you didn't create a MidwayTicket account, you can ignore this email.</p>
    </div>
    <div style="padding:16px 24px;background:#F8FAFC;text-align:center;font-size:11px;color:#94A3B8;">MidwayTicket · support@midwayticket.in</div>
  </div>
</body>
</html>`,
    });
    this.logger.log(`Verification email sent → ${email}`);
  }

  private async sendPasswordResetEmail({ email, name, resetUrl }: SendPasswordResetEmailJob) {
    await this.transporter.sendMail({
      from:    this.config.get("app.smtp.from", "tickets@midwayticket.in"),
      to:      email,
      subject: "Reset your MidwayTicket password",
      html: `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#F8FAFC;margin:0;padding:20px;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);">
    <div style="background:linear-gradient(135deg,#0F172A,#1E293B);padding:24px;text-align:center;">
      <div style="color:#38BDF8;font-size:12px;font-weight:700;letter-spacing:.1em;margin-bottom:4px;">MIDWAYTICKET</div>
      <div style="color:#fff;font-size:22px;font-weight:700;">Reset your password</div>
    </div>
    <div style="padding:24px;">
      <p style="color:#64748B;font-size:14px;">Hi ${name},<br>We received a request to reset your password. Click below to set a new one.</p>
      <div style="text-align:center;margin:24px 0;">
        <a href="${resetUrl}" style="display:inline-block;background:#0EA5E9;color:#fff;font-weight:600;font-size:14px;padding:12px 28px;border-radius:10px;text-decoration:none;">Reset Password</a>
      </div>
      <p style="color:#94A3B8;font-size:12px;">This link expires in 1 hour. If you didn't request this, your password is still safe — just ignore this email.</p>
    </div>
    <div style="padding:16px 24px;background:#F8FAFC;text-align:center;font-size:11px;color:#94A3B8;">MidwayTicket · support@midwayticket.in</div>
  </div>
</body>
</html>`,
    });
    this.logger.log(`Password reset email sent → ${email}`);
  }

  private async sendTicketEmail({ ticketIds }: SendTicketJob) {
    // FIX: this used to load a single ticket with relations ["customer",
    // "ride", "fair"] — no "event" relation at all. Any ticket booked
    // through the Events flow (ride/fair both null, event set instead)
    // would silently render "Your ticket for undefined" in the subject and
    // body, since ticket.ride?.name was always undefined for those.
    const tickets = await this.tickets.find({
      where:     { id: In(ticketIds) },
      relations: ["customer", "ride", "fair", "event"],
      select: {
        qrToken: true, id: true, displayId: true, quantity: true,
        totalAmount: true, eventDate: true,
      },
    });

    if (tickets.length === 0) {
      this.logger.error(`None of tickets [${ticketIds.join(", ")}] found for email`);
      return;
    }

    const customer = tickets[0].customer;
    if (!customer?.email) {
      this.logger.error(`Ticket batch [${ticketIds.join(", ")}] has no customer email`);
      return;
    }

    // One QR image per ticket, each with its own cid so it embeds
    // correctly as a distinct inline image in the HTML below.
    const withQr = await Promise.all(
      tickets.map(async (ticket, i) => ({
        ticket,
        cid: `qrcode${i}`,
        qrDataUrl: await QRCode.toDataURL(ticket.qrToken, {
          errorCorrectionLevel: "H",
          margin: 2,
          width: 300,
        }),
      })),
    );

    const isEvent = !!tickets[0].event;
    const subjectName = isEvent ? tickets[0].event?.name : tickets[0].ride?.name;
    const html = this.buildEmailHtml(withQr, isEvent);

    await this.transporter.sendMail({
      from:    this.config.get("app.smtp.from", "tickets@midwayticket.in"),
      to:      customer.email,
      subject: tickets.length > 1
        ? `Your ${tickets.length} tickets for ${subjectName}`
        : `Your ticket for ${subjectName} — #${tickets[0].displayId}`,
      html,
      attachments: withQr.map(({ ticket, cid, qrDataUrl }) => ({
        filename:    `midwayticket-${ticket.displayId}.png`,
        path:        qrDataUrl,
        contentType: "image/png",
        cid,
      })),
    });

    this.logger.log(`Ticket email sent for [${tickets.map((t) => t.displayId).join(", ")}] → ${customer.email}`);
  }

  private buildEmailHtml(
    withQr: { ticket: any; cid: string; qrDataUrl: string }[],
    isEvent: boolean,
  ): string {
    const first = withQr[0].ticket;
    const customerName = first.customer?.name;
    const venueLine = isEvent
      ? `<div class="row"><span class="label">Event</span><span class="value">${first.event?.name}</span></div>
         <div class="row"><span class="label">Venue</span><span class="value">${first.event?.venue}</span></div>`
      : `<div class="row"><span class="label">Ride</span><span class="value">${first.ride?.name}</span></div>
         <div class="row"><span class="label">Fair</span><span class="value">${first.fair?.name}</span></div>`;

    const totalPaid = withQr.reduce((sum, { ticket }) => sum + Number(ticket.totalAmount), 0);

    const qrBlocks = withQr.map(({ ticket, cid }, i) => `
      <div class="qr-section" style="${i > 0 ? "margin-top:12px;" : ""}">
        <img src="cid:${cid}" alt="QR Code" />
        <div class="ticket-id">#${ticket.displayId}</div>
        <div class="qr-label">${withQr.length > 1 ? `Ticket ${i + 1} of ${withQr.length} — ` : ""}Show this QR code at the gate</div>
      </div>
    `).join("");

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#F8FAFC; margin:0; padding:20px; }
    .card { max-width:480px; margin:0 auto; background:#fff; border-radius:16px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,.08); }
    .header { background:linear-gradient(135deg,#0F172A,#1E293B); padding:24px; text-align:center; }
    .brand { color:#38BDF8; font-size:12px; font-weight:700; letter-spacing:.1em; margin-bottom:4px; }
    .title { color:#fff; font-size:22px; font-weight:700; }
    .body { padding:24px; }
    .row { display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid #F1F5F9; font-size:14px; }
    .label { color:#64748B; }
    .value { font-weight:600; color:#0F172A; }
    .qr-section { text-align:center; padding:20px; background:#F8FAFC; border-radius:12px; margin-top:16px; }
    .qr-section img { width:160px; height:160px; }
    .qr-label { font-size:11px; color:#64748B; margin-top:8px; }
    .ticket-id { font-size:18px; font-weight:700; color:#0F172A; font-family:monospace; }
    .footer { padding:16px 24px; background:#F8FAFC; text-align:center; font-size:11px; color:#94A3B8; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="brand">MIDWAYTICKET</div>
      <div class="title">${withQr.length > 1 ? `Your ${withQr.length} tickets are ready! 🎉` : "Your ticket is ready! 🎉"}</div>
    </div>
    <div class="body">
      <p style="color:#64748B;font-size:14px;margin-top:0">Hi ${customerName},<br>Your booking is confirmed. ${withQr.length > 1 ? "Each person shows their own QR code at the gate — they scan independently." : "Show the QR below at the gate."}</p>
      ${venueLine}
      <div class="row"><span class="label">Date</span><span class="value">${first.eventDate}</span></div>
      <div class="row"><span class="label">Tickets</span><span class="value">${withQr.length}</span></div>
      <div class="row"><span class="label">Amount Paid</span><span class="value">₹${totalPaid}</span></div>
      ${qrBlocks}
    </div>
    <div class="footer">
      MidwayTicket · support@midwayticket.in<br/>
      ${withQr.length > 1 ? "Each ticket is valid for one use only." : "This ticket is valid for one use only."}
    </div>
  </div>
</body>
</html>`;
  }
}
