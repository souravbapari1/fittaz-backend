// Tiny abstraction over outbound email so the rest of the codebase doesn't
// care which provider (Resend, SendGrid, Postmark, raw SMTP, …) is in use.
//
// The default export is a [ConsoleEmailService] that just prints to the
// server console — appropriate for local dev and for shipping the
// password-reset flow before we sign up for a real email provider.
//
// To swap in a real provider:
//   1. Add a new class that implements [EmailService].
//   2. Construct it here and assign to `emailService`.
//
// Keep this file free of provider-specific deps so importing it never pulls
// in an SDK we don't actually use.

export interface OtpEmail {
  to: string;
  code: string;
  ttlMinutes: number;
}

export interface EmailService {
  sendPasswordResetCode(payload: OtpEmail): Promise<void>;
  sendEmailVerificationCode(payload: OtpEmail): Promise<void>;
}

/**
 * Dev / stub implementation. Logs the OTP code to the server console.
 * Replace with a real provider before going to production.
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

export const emailService: EmailService = new ConsoleEmailService();
