// Tiny abstraction over outbound email so the rest of the codebase doesn't
// care which provider (Resend, SendGrid, Postmark, raw SMTP, …) is in use.
//
// Two implementations ship here:
//   - [SmtpEmailService]    — real delivery over SMTP (nodemailer). Used
//                             automatically when SMTP_* env vars are set.
//   - [ConsoleEmailService] — dev fallback that prints the OTP to stdout.
//
// The selection happens once at the bottom of this file, so callers just
// `import { emailService }` and never branch on configuration.

import nodemailer, { type Transporter } from "nodemailer";

export interface OtpEmail {
  to: string;
  code: string;
  ttlMinutes: number;
}

export interface EmailService {
  sendPasswordResetCode(payload: OtpEmail): Promise<void>;
  sendEmailVerificationCode(payload: OtpEmail): Promise<void>;
}

/** Product name used in subjects, the sender label and the email body. */
const APP_NAME = process.env.EMAIL_APP_NAME?.trim() || "Fittaz";

/**
 * Dev / stub implementation. Logs the OTP code to the server console.
 * Used whenever SMTP isn't configured, so local dev needs no credentials.
 */
export class ConsoleEmailService implements EmailService {
  async sendPasswordResetCode(p: OtpEmail): Promise<void> {
    this._log("PASSWORD RESET CODE", p);
  }

  async sendEmailVerificationCode(p: OtpEmail): Promise<void> {
    this._log("EMAIL VERIFICATION CODE", p);
  }

  /**
   * Shared formatter for the dev-only console codes. Centralised so
   * password reset and email verification look identical in the log
   * (different headers only) — operators learn the shape once and
   * spot it instantly regardless of which OTP just dropped.
   */
  private _log(title: string, { to, code, ttlMinutes }: OtpEmail): void {
    // Pad to 6 chars defensively — the generator already does this but
    // we don't trust the source here in case a future caller forgets.
    const padded = code.padStart(6, "0");
    const lines = [
      "",
      "════════════════════════════════════════",
      `  ${title}`,
      "════════════════════════════════════════",
      `  To:         ${to}`,
      `  Code:       ${padded}`,
      `  Expires in: ${ttlMinutes} minutes`,
      "════════════════════════════════════════",
      "",
    ];
    console.log(lines.join("\n"));
  }
}

/** Everything [SmtpEmailService] needs to connect and address a message. */
export interface SmtpConfig {
  host: string;
  port: number;
  /** true for implicit TLS (port 465); false for STARTTLS (587). */
  secure: boolean;
  user: string;
  pass: string;
  /** RFC 5322 From header, e.g. `Fittaz <no-reply@fittaz.com>`. */
  from: string;
}

/**
 * Real delivery over SMTP. Works with Gmail app passwords, Zoho, SES SMTP,
 * Mailgun SMTP — anything that speaks plain SMTP AUTH.
 *
 * The transport is created once and reused; nodemailer pools nothing by
 * default but keeps DNS/TLS handshake cost down across sends via `pool`.
 */
export class SmtpEmailService implements EmailService {
  private readonly _transporter: Transporter;
  private readonly _from: string;

  constructor(cfg: SmtpConfig) {
    this._from = cfg.from;
    this._transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
      pool: true,
    });
  }

  async sendPasswordResetCode(p: OtpEmail): Promise<void> {
    await this._send({
      to: p.to,
      subject: `${this._padded(p.code)} is your ${APP_NAME} password reset code`,
      heading: "Reset your password",
      intro:
        `We received a request to reset the password for your ${APP_NAME} account. ` +
        "Enter this code in the app to choose a new password.",
      code: p.code,
      ttlMinutes: p.ttlMinutes,
      footer:
        "If you didn't request a password reset, you can safely ignore this " +
        "email — your password stays unchanged.",
    });
  }

  async sendEmailVerificationCode(p: OtpEmail): Promise<void> {
    await this._send({
      to: p.to,
      subject: `${this._padded(p.code)} is your ${APP_NAME} verification code`,
      heading: "Verify your email",
      intro:
        `Welcome to ${APP_NAME}! Enter this code in the app to confirm this ` +
        "email address belongs to you.",
      code: p.code,
      ttlMinutes: p.ttlMinutes,
      footer:
        "If you didn't create a " +
        APP_NAME +
        " account, you can safely ignore this email.",
    });
  }

  /** Same defensive padding the console service applies. */
  private _padded(code: string): string {
    return code.padStart(6, "0");
  }

  private async _send(m: {
    to: string;
    subject: string;
    heading: string;
    intro: string;
    code: string;
    ttlMinutes: number;
    footer: string;
  }): Promise<void> {
    const code = this._padded(m.code);
    await this._transporter.sendMail({
      from: this._from,
      to: m.to,
      subject: m.subject,
      text: [
        m.heading,
        "",
        m.intro,
        "",
        `Code: ${code}`,
        `This code expires in ${m.ttlMinutes} minutes.`,
        "",
        m.footer,
        "",
        `— ${APP_NAME}`,
      ].join("\n"),
      html: otpHtml({ ...m, code }),
    });
  }
}

/**
 * Inline-styled OTP email. Mail clients strip <style> blocks and don't do
 * flexbox, so everything here is table-free block layout with inline CSS —
 * the lowest common denominator that renders the same in Gmail, Outlook
 * and iOS Mail.
 */
function otpHtml(m: {
  heading: string;
  intro: string;
  code: string;
  ttlMinutes: number;
  footer: string;
}): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:480px;margin:0 auto;padding:32px 20px;">
      <div style="background:#ffffff;border-radius:14px;padding:32px 28px;border:1px solid #e5e7eb;">
        <div style="font-size:13px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#16a34a;margin-bottom:20px;">
          ${escapeHtml(APP_NAME)}
        </div>
        <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#111827;">
          ${escapeHtml(m.heading)}
        </h1>
        <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#4b5563;">
          ${escapeHtml(m.intro)}
        </p>
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:18px;text-align:center;margin-bottom:16px;">
          <div style="font-size:32px;font-weight:700;letter-spacing:10px;color:#14532d;font-family:'SF Mono',Menlo,Consolas,monospace;">
            ${escapeHtml(m.code)}
          </div>
        </div>
        <p style="margin:0 0 24px;font-size:13px;color:#6b7280;text-align:center;">
          This code expires in ${m.ttlMinutes} minutes.
        </p>
        <hr style="border:0;border-top:1px solid #e5e7eb;margin:0 0 20px;" />
        <p style="margin:0;font-size:13px;line-height:1.6;color:#9ca3af;">
          ${escapeHtml(m.footer)}
        </p>
      </div>
      <p style="margin:20px 0 0;text-align:center;font-size:12px;color:#9ca3af;">
        © ${new Date().getFullYear()} ${escapeHtml(APP_NAME)}. All rights reserved.
      </p>
    </div>
  </body>
</html>`;
}

/** Codes and app names are ours, but escape anyway so no input can inject markup. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Reads SMTP_* env vars. Returns null when the required ones are missing so
 * the caller can fall back to the console service instead of crashing —
 * a dev clone with no credentials must still boot.
 */
function smtpConfigFromEnv(): SmtpConfig | null {
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  // Gmail app passwords are shown in groups of four; strip the spaces so a
  // straight copy/paste from the Google UI works.
  const pass = process.env.SMTP_PASS?.replace(/\s+/g, "");
  if (!host || !user || !pass) return null;

  const port = Number(process.env.SMTP_PORT ?? 587);
  if (!Number.isFinite(port) || port <= 0) {
    console.warn("[email] invalid SMTP_PORT, falling back to console output");
    return null;
  }

  // Explicit override wins; otherwise infer from the port (465 = implicit TLS).
  const secureEnv = process.env.SMTP_SECURE?.trim().toLowerCase();
  const secure = secureEnv ? secureEnv === "true" || secureEnv === "1" : port === 465;

  const fromName = process.env.SMTP_FROM_NAME?.trim() || APP_NAME;
  const fromAddress = process.env.SMTP_FROM?.trim() || user;

  return {
    host,
    port,
    secure,
    user,
    pass,
    // Gmail rewrites From to the authenticated account anyway, but sending a
    // matching address keeps other providers (and SPF) happy.
    from: `${fromName} <${fromAddress}>`,
  };
}

function createEmailService(): EmailService {
  const cfg = smtpConfigFromEnv();
  if (!cfg) {
    console.log("[email] SMTP not configured — OTP codes will print to the console");
    return new ConsoleEmailService();
  }
  console.log(`[email] SMTP enabled via ${cfg.host}:${cfg.port} as ${cfg.user}`);
  return new SmtpEmailService(cfg);
}

export const emailService: EmailService = createEmailService();
