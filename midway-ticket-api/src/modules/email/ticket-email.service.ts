// ─────────────────────────────────────────────────────────────────────────────
// Ticket Email Service — sends confirmation/verification/reset emails DIRECTLY
// ─────────────────────────────────────────────────────────────────────────────
//
// FIX: emails used to go through a BullMQ queue backed by Redis
// (email.processor.ts, the "email" queue). Redis on this project's Railway
// deployment has been unreachable for an extended period (ioredis
// "Command timed out" errors, continuously, confirmed live in production
// logs) — a platform credentials issue that code changes alone can't repair.
// Every email enqueued through that queue was silently never sent: the
// booking/ticket-issuance call itself was already made fire-and-forget
// specifically so a broken queue couldn't also break ticket issuance, but
// that same fire-and-forget shrug meant nobody ever found out the email
// step itself was failing — the frontend's "Also emailed to X" message was
// unconditional, shown on successful ticket issuance regardless of whether
// the email actually went anywhere.
//
// Removing Redis from this path entirely is the fix: sendMail() is called
// directly, awaited with a bounded timeout (an unreachable SMTP server
// should never be able to hang a ticket purchase either), and callers now
// get back a real emailSent: boolean instead of an unconditional promise.
import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, In } from "typeorm";
import { ConfigService } from "@nestjs/config";
import * as nodemailer from "nodemailer";
import * as QRCode from "qrcode";
import { TicketEntity } from "../entities";

const SEND_TIMEOUT_MS = 8_000;

@Injectable()
export class TicketEmailService {
  private readonly logger = new Logger(TicketEmailService.name);
  private readonly transporter: nodemailer.Transporter;

  constructor(
    @InjectRepository(TicketEntity) private tickets: Repository<TicketEntity>,
    private readonly config: ConfigService,
  ) {
    this.transporter = nodemailer.createTransport({
      host: config.get("app.smtp.host"),
      port: config.get("app.smtp.port", 587),
      auth: {
        user: config.get("app.smtp.user"),
        pass: config.get("app.smtp.pass"),
      },
    });
  }

  /** Wraps any send in a hard ceiling so a slow/unreachable SMTP server can never hang the caller. */
  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`Email send timed out after ${SEND_TIMEOUT_MS}ms`)), SEND_TIMEOUT_MS),
      ),
    ]);
  }

  /**
   * Sends the confirmation email for a purchase and reports whether it
   * actually went out. Never throws — a failed/slow email must never break
   * ticket issuance, which has already completed by the time this runs.
   */
  async sendTicketEmail(ticketIds: string[], magicLinkUrl?: string): Promise<boolean> {
    try {
      await this.withTimeout(this.doSendTicketEmail(ticketIds, magicLinkUrl));
      return true;
    } catch (err) {
      this.logger.error(`Ticket email failed for [${ticketIds.join(", ")}]: ${(err as Error).message}`);
      return false;
    }
  }

  async sendVerificationEmail(params: { email: string; name: string; verifyUrl: string }): Promise<boolean> {
    try {
      await this.withTimeout(this.doSendVerificationEmail(params));
      return true;
    } catch (err) {
      this.logger.error(`Verification email failed for ${params.email}: ${(err as Error).message}`);
      return false;
    }
  }

  async sendPasswordResetEmail(params: { email: string; name: string; resetUrl: string }): Promise<boolean> {
    try {
      await this.withTimeout(this.doSendPasswordResetEmail(params));
      return true;
    } catch (err) {
      this.logger.error(`Password reset email failed for ${params.email}: ${(err as Error).message}`);
      return false;
    }
  }

  /** "My Tickets" — a sign-in link that's also this email's proof of ownership. */
  async sendMagicLinkEmail(params: { email: string; name: string; magicLinkUrl: string }): Promise<boolean> {
    try {
      await this.withTimeout(this.doSendMagicLinkEmail(params));
      return true;
    } catch (err) {
      this.logger.error(`Magic link email failed for ${params.email}: ${(err as Error).message}`);
      return false;
    }
  }

  // ── Internal senders (unchanged content/logic from the old processor) ──────

  private async doSendVerificationEmail({ email, name, verifyUrl }: { email: string; name: string; verifyUrl: string }) {
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

  private async doSendPasswordResetEmail({ email, name, resetUrl }: { email: string; name: string; resetUrl: string }) {
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

  private async doSendMagicLinkEmail({ email, name, magicLinkUrl }: { email: string; name: string; magicLinkUrl: string }) {
    await this.transporter.sendMail({
      from:    this.config.get("app.smtp.from", "tickets@midwayticket.in"),
      to:      email,
      subject: "View your MidwayTicket tickets",
      html: `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#F8FAFC;margin:0;padding:20px;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);">
    <div style="background:linear-gradient(135deg,#0F172A,#1E293B);padding:24px;text-align:center;">
      <div style="color:#38BDF8;font-size:12px;font-weight:700;letter-spacing:.1em;margin-bottom:4px;">MIDWAYTICKET</div>
      <div style="color:#fff;font-size:22px;font-weight:700;">View your tickets</div>
    </div>
    <div style="padding:24px;">
      <p style="color:#64748B;font-size:14px;">Hi ${name},<br>Tap below to securely sign in and see every ticket booked with this email address — no password needed.</p>
      <div style="text-align:center;margin:24px 0;">
        <a href="${magicLinkUrl}" style="display:inline-block;background:#0EA5E9;color:#fff;font-weight:600;font-size:14px;padding:12px 28px;border-radius:10px;text-decoration:none;">View My Tickets</a>
      </div>
      <p style="color:#94A3B8;font-size:12px;">This link expires in 30 minutes and can only be used once. If you didn't request this, you can safely ignore this email.</p>
    </div>
    <div style="padding:16px 24px;background:#F8FAFC;text-align:center;font-size:11px;color:#94A3B8;">MidwayTicket · support@midwayticket.in</div>
  </div>
</body>
</html>`,
    });
    this.logger.log(`Magic link email sent → ${email}`);
  }

  private async doSendTicketEmail(ticketIds: string[], magicLinkUrl?: string) {
    const tickets = await this.tickets.find({
      where:     { id: In(ticketIds) },
      relations: ["customer", "ride", "fair", "event"],
      select: {
        qrToken: true, id: true, displayId: true, quantity: true,
        totalAmount: true, eventDate: true,
      },
    });

    if (tickets.length === 0) {
      throw new Error(`None of tickets [${ticketIds.join(", ")}] found for email`);
    }

    const customer = tickets[0].customer;
    if (!customer?.email) {
      throw new Error(`Ticket batch [${ticketIds.join(", ")}] has no customer email`);
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
    const html = this.buildEmailHtml(withQr, isEvent, magicLinkUrl);

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
    magicLinkUrl?: string,
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
      ${magicLinkUrl ? `
      <div style="text-align:center;margin-top:20px;padding-top:20px;border-top:1px solid #F1F5F9;">
        <p style="color:#64748B;font-size:13px;margin-bottom:10px;">Want to see this and any other tickets under this email, anytime?</p>
        <a href="${magicLinkUrl}" style="display:inline-block;background:#F1F5F9;color:#0F172A;font-weight:600;font-size:13px;padding:10px 22px;border-radius:10px;text-decoration:none;">View All My Tickets</a>
      </div>` : ""}
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
