// Tiny abstraction over outbound SMS so the rest of the codebase doesn't
// care which provider (Fast2SMS, MSG91, Twilio, …) is in use.
//
// Two implementations ship here:
//   - [Fast2SmsService]   — real delivery over the Fast2SMS Dev API
//                            (https://www.fast2sms.com/dev/bulkV2, route=otp).
//                            Used automatically when FAST2SMS_API_KEY is set.
//   - [ConsoleSmsService] — dev fallback that prints the OTP to stdout.
//
// The selection happens once at the bottom of this file, so callers just
// `import { smsService }` and never branch on configuration. Mirrors the
// shape of `email.ts` on purpose so the OTP plumbing stays uniform.

export interface OtpSms {
  /** 10-digit Indian mobile number, no country code / leading 0. */
  to: string;
  code: string;
  ttlMinutes: number;
}

export interface SmsService {
  sendOtpCode(payload: OtpSms): Promise<void>;
}

/** Product name used in the dev console log + the (optional) message body. */
const APP_NAME = process.env.SMS_APP_NAME?.trim() || "Fittaz";

/**
 * Dev / stub implementation. Logs the OTP code to the server console.
 * Used whenever FAST2SMS_API_KEY isn't configured, so local dev needs no
 * credentials — same philosophy as `ConsoleEmailService`.
 */
export class ConsoleSmsService implements SmsService {
  async sendOtpCode(p: OtpSms): Promise<void> {
    const padded = p.code.padStart(6, "0");
    const lines = [
      "",
      "════════════════════════════════════════",
      "  SMS OTP CODE",
      "════════════════════════════════════════",
      `  To:         +91 ${p.to}`,
      `  Code:       ${padded}`,
      `  Expires in: ${p.ttlMinutes} minutes`,
      "════════════════════════════════════════",
      "",
    ];
    console.log(lines.join("\n"));
  }
}

/**
 * Real delivery over the Fast2SMS Dev API.
 *
 * Uses the `route=otp` endpoint, which delivers the SMS as
 * "Your OTP: <code>" (Fast2SMS wraps the value in their own template).
 * No DLT registration is required for this route — it goes out via the
 * premium numeric-sender path, which is fine for transactional OTPs.
 *
 * The API key is sent in the `authorization` header. We use the global
 * `fetch` (available in Bun and Node 18+) so no extra dependency is needed.
 */
export class Fast2SmsService implements SmsService {
  private readonly _apiKey: string;
  private readonly _endpoint: string;

  constructor(apiKey: string, endpoint = "https://www.fast2sms.com/dev/bulkV2") {
    this._apiKey = apiKey;
    this._endpoint = endpoint;
  }

  async sendOtpCode(p: OtpSms): Promise<void> {
    const padded = p.code.padStart(6, "0");
    const res = await fetch(this._endpoint, {
      method: "POST",
      headers: {
        authorization: this._apiKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        // Fast2SMS's OTP route wraps the value in "Your OTP: <code>".
        variables_values: padded,
        route: "otp",
        numbers: p.to,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Fast2SMS HTTP ${res.status}: ${body.slice(0, 200) || res.statusText}`,
      );
    }

    // Fast2SMS returns 200 with `{ return: false, message: "..." }` on
    // logical failures (bad number, insufficient balance, …). Treat
    // those as errors too so the caller surfaces them.
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return; // Non-JSON 200 is unusual but not worth crashing on.
    }
    if (json && typeof json === "object" && "return" in json) {
      const ok = (json as { return?: unknown }).return;
      // Fast2SMS sends `return: false` on failure and `return: true` (or
      // a string like "true") on success. Be defensive about the shape.
      const succeeded = ok === true || ok === "true" || ok === 1;
      if (!succeeded) {
        const message =
          (json as { message?: unknown }).message ?? "Fast2SMS rejected the request";
        throw new Error(`Fast2SMS: ${message}`);
      }
    }
  }
}

/**
 * Reads FAST2SMS_* env vars. Returns null when the API key is missing so
 * the caller can fall back to the console service instead of crashing —
 * a dev clone with no credentials must still boot.
 */
function createSmsService(): SmsService {
  const apiKey = process.env.FAST2SMS_API_KEY?.trim();
  if (!apiKey) {
    console.log(
      `[sms] FAST2SMS_API_KEY not set — OTP codes will print to the console`,
    );
    return new ConsoleSmsService();
  }
  console.log(`[sms] Fast2SMS enabled (key …${apiKey.slice(-4)})`);
  return new Fast2SmsService(apiKey);
}

export const smsService: SmsService = createSmsService();
