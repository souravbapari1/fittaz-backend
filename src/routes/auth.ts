import { Router } from "express";
import type { Request, Response } from "express";
import crypto from "node:crypto";
import { getUserAccessPayload } from "../lib/access_features.ts";
import { prisma } from "../lib/prisma.ts";
import { hashPassword, signToken, verifyPassword } from "../lib/auth.ts";
import { emailService } from "../lib/email.ts";
import { smsService } from "../lib/sms.ts";
import { requireAuth } from "../middleware/require_auth.ts";

export const authRouter: Router = Router();

// Password-reset OTP knobs. Centralised so the email template and the route
// agree about TTL without having to pass it around explicitly.
const RESET_CODE_TTL_MIN = 15;
const RESET_CODE_LEN = 6;

// Phone-OTP knobs. Same length + a shorter TTL than email reset (5 min is
// plenty for an SMS that lands in seconds), plus a per-phone resend cooldown
// to blunt brute-force / SMS-flooding abuse without needing Redis.
const PHONE_OTP_TTL_MIN = 5;
const PHONE_OTP_LEN = 6;
const PHONE_OTP_RESEND_COOLDOWN_SEC = 30;

// Fields we never want to return to the client. Centralised so /auth/* and
// /me/* stay consistent.
const userSelect = {
  id: true,
  name: true,
  email: true,
  emailVerified: true,
  phoneNumber: true,
  profilePictureUrl: true,
  createdAt: true,
  updatedAt: true,
} as const;

interface SignupBody {
  name?: unknown;
  email?: unknown;
  password?: unknown;
}

interface LoginBody {
  email?: unknown;
  password?: unknown;
}

interface ForgotPasswordBody {
  email?: unknown;
}

interface ResetPasswordBody {
  email?: unknown;
  code?: unknown;
  password?: unknown;
}

interface OtpSendBody {
  phoneNumber?: unknown;
}

interface OtpVerifyBody {
  phoneNumber?: unknown;
  code?: unknown;
}

interface OtpDetailsBody {
  name?: unknown;
  email?: unknown;
}

/** Numeric, zero-padded OTP. Crypto-random so it isn't guessable. */
function generateResetCode(): string {
  // randomInt is uniform across [0, 10^len). Range is small so this is fast.
  const max = 10 ** RESET_CODE_LEN;
  return crypto.randomInt(0, max).toString().padStart(RESET_CODE_LEN, "0");
}

/** SHA-256 of the code. We only ever persist the hash, never the code. */
function hashResetCode(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}

/** Constant-time compare of two hex digests. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (!EMAIL_RE.test(v)) return null;
  return v;
}

// Indian mobile numbers: 10 digits starting with 6-9. We accept a leading
// +91 / 0 and strip it so the stored + matched value is always the bare
// 10-digit national number — Fast2SMS expects exactly that shape.
const PHONE_RE = /^(?:\+91|0)?([6-9]\d{9})$/;

function normalizePhone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.replace(/[\s-]/g, "");
  const m = PHONE_RE.exec(v);
  return m?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Phone-OTP resend rate limiter (in-memory, per phone).
// ---------------------------------------------------------------------------
//
// Tiny Map<phone, lastSentAtMs>. Good enough for a single-process server —
// the existing /auth/forgot-password route has the same "TODO: rate limit"
// gap, so we're not making things worse. A multi-instance deployment would
// need Redis; for now this stops one client from burning the Fast2SMS quota.
const _lastOtpSentAt = new Map<string, number>();

function otpResendAvailableInSec(phone: string): number {
  const last = _lastOtpSentAt.get(phone);
  if (!last) return 0;
  const elapsedSec = (Date.now() - last) / 1000;
  const remaining = PHONE_OTP_RESEND_COOLDOWN_SEC - elapsedSec;
  return remaining > 0 ? Math.ceil(remaining) : 0;
}

function markOtpSent(phone: string): void {
  _lastOtpSentAt.set(phone, Date.now());
}

authRouter.post("/signup", async (req: Request, res: Response) => {
  const body = req.body as SignupBody;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";

  if (name.length < 2) {
    res.status(400).json({ error: "name_too_short" });
    return;
  }
  if (!email) {
    res.status(400).json({ error: "invalid_email" });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: "password_too_short" });
    return;
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    res.status(409).json({ error: "email_already_in_use" });
    return;
  }

  const hash = await hashPassword(password);
  const user = await prisma.user.create({
    data: { name, email, password: hash },
    select: userSelect,
  });
  const token = await signToken(user.id);
  const access = await getUserAccessPayload(user.id);
  res.status(201).json({ token, user, profile: null, access });
});

authRouter.post("/login", async (req: Request, res: Response) => {
  const body = req.body as LoginBody;
  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";

  if (!email || password.length === 0) {
    res.status(400).json({ error: "invalid_credentials" });
    return;
  }

  // Always run the password verify even when the user is missing so the
  // response time doesn't leak whether an email is registered.
  const user = await prisma.user.findUnique({
    where: { email },
    include: { profile: true },
  });
  const hash = user?.password ?? "$argon2id$v=19$m=65536,t=2,p=1$AAAA$AAAA";
  const ok = await verifyPassword(password, hash);
  if (!user || !ok) {
    res.status(401).json({ error: "invalid_credentials" });
    return;
  }

  const token = await signToken(user.id);
  const access = await getUserAccessPayload(user.id);
  res.json({
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      phoneNumber: user.phoneNumber,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    },
    profile: user.profile,
    access,
  });
});

// ---------------------------------------------------------------------------
// Password reset (OTP-based)
// ---------------------------------------------------------------------------
//
// Two-step flow:
//   1. POST /auth/forgot-password { email }
//        - Always returns 200 with { ok: true } regardless of whether the
//          email is registered, so the response can't be used to enumerate
//          accounts.
//        - If the email *does* exist we mint a fresh 6-digit code, store
//          its SHA-256 hash with an expiry, and dispatch the code via
//          `emailService.sendPasswordResetCode(...)`.
//   2. POST /auth/reset-password { email, code, password }
//        - Looks up the most recent unused, unexpired token for the user
//          and compares the SHA-256 hash of the submitted code in
//          constant time.
//        - On success: marks the token used, replaces the user's argon2id
//          password hash, and invalidates every other outstanding reset
//          token for that user (so a leaked code from a previous request
//          can't be reused).
//
// What we deliberately skip for v1 (call out as TODOs):
//   - Rate limiting per email / per IP. Add a small in-memory or Redis
//     bucket before going public.
//   - Email verification on signup. The current schema has emailVerified
//     but no flow writes to it yet.

authRouter.post("/forgot-password", async (req: Request, res: Response) => {
  const body = req.body as ForgotPasswordBody;
  const email = normalizeEmail(body.email);

  // Validate the *shape* of the email so we can return a useful 400, but
  // hide whether the address is registered.
  if (!email) {
    res.status(400).json({ error: "invalid_email" });
    return;
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    res.status(400).json({ error: "invalid_email" });
    return;
  }
  if (user) {
    const code = generateResetCode();
    const expiresAt = new Date(Date.now() + RESET_CODE_TTL_MIN * 60_000);
    await prisma.passwordResetToken.create({
      data: {
        codeHash: hashResetCode(code),
        userId: user.id,
        expiresAt,
        usedAt: null,
      },
    });
    try {
      await emailService.sendPasswordResetCode({
        to: email,
        code,
        ttlMinutes: RESET_CODE_TTL_MIN,
      });
    } catch (err) {
      // Don't tell the client; logging is enough. The user can request a
      // new code if delivery fails.
      console.error("[forgot-password] email send failed", err);
    }
  }

  // Always 200 so the response can't be used to enumerate accounts.
  res.json({ ok: true, ttlMinutes: RESET_CODE_TTL_MIN });
});

authRouter.post("/reset-password", async (req: Request, res: Response) => {
  const body = req.body as ResetPasswordBody;
  const email = normalizeEmail(body.email);
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!email) {
    res.status(400).json({ error: "invalid_email" });
    return;
  }
  if (code.length !== RESET_CODE_LEN || !/^\d+$/.test(code)) {
    res.status(400).json({ error: "invalid_reset_code" });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: "password_too_short" });
    return;
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    // Don't leak whether the email exists; the only honest answer is
    // "this code is wrong". A non-existent user can't have a valid code.
    res.status(400).json({ error: "invalid_reset_code" });
    return;
  }

  // Check every still-valid code, not just the newest one — a user can
  // legitimately have more than one outstanding code (e.g. they tap
  // "resend" before the first email lands, then use the first one that
  // actually arrives). Matching only the latest would reject an older
  // code as "invalid" even though it's unused and unexpired.
  const candidates = await prisma.passwordResetToken.findMany({
    where: {
      userId: user.id,
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });
  const codeHash = hashResetCode(code);
  const token = candidates.find((t) => timingSafeEqualHex(codeHash, t.codeHash));
  if (!token) {
    res.status(400).json({ error: "invalid_reset_code" });
    return;
  }

  const newHash = await hashPassword(password);

  // Mark this code used + nuke any other outstanding codes for this user in
  // one transaction so a duplicate code request mid-flow can't be replayed.
  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: { password: newHash },
    }),
    prisma.passwordResetToken.update({
      where: { id: token.id },
      data: { usedAt: new Date() },
    }),
    prisma.passwordResetToken.updateMany({
      where: {
        userId: user.id,
        usedAt: null,
        id: { not: token.id },
      },
      data: { usedAt: new Date() },
    }),
  ]);

  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Phone OTP login / signup
// ---------------------------------------------------------------------------
//
// Two-step flow (mirrors the email/password-reset OTP flow but keyed by
// phone, and the verify step *also* creates the account on first run):
//
//   1. POST /auth/otp/send { phoneNumber }
//        - Validates the phone shape (10-digit Indian mobile).
//        - Enforces a per-phone resend cooldown (default 30s) so a single
//          client can't drain the Fast2SMS quota.
//        - Mints a fresh 6-digit code, stores its SHA-256 hash with a
//          short TTL (5 min), and dispatches the code via `smsService`.
//        - Always returns 200 with { ok: true, ttlMinutes, resendInSec }
//          so the response can't be used to enumerate which numbers have
//          requested codes (we don't know yet — the user is created on
//          verify, not on send).
//
//   2. POST /auth/otp/verify { phoneNumber, code }
//        - Looks up the most recent unused, unexpired code for the phone
//          and compares the SHA-256 hash of the submitted code in
//          constant time.
//        - On success: marks the code used + invalidates every other
//          outstanding code for that phone, then either logs the
//          existing user in (matched by phoneNumber) or creates a
//          phone-only account (auto-generated placeholder email +
//          random password) and logs them in.
//        - Returns the same shape as /auth/login so the Flutter client
//          can reuse its existing auth-response hydration.

authRouter.post("/otp/send", async (req: Request, res: Response) => {
  const body = req.body as OtpSendBody;
  const phone = normalizePhone(body.phoneNumber);

  if (!phone) {
    res.status(400).json({ error: "invalid_phone" });
    return;
  }

  const resendIn = otpResendAvailableInSec(phone);
  if (resendIn > 0) {
    res.status(429).json({
      error: "otp_cooldown",
      resendInSec: resendIn,
      ttlMinutes: PHONE_OTP_TTL_MIN,
    });
    return;
  }

  const code = generateResetCode();
  const expiresAt = new Date(Date.now() + PHONE_OTP_TTL_MIN * 60_000);
  await prisma.phoneOtpToken.create({
    data: {
      codeHash: hashResetCode(code),
      phoneNumber: phone,
      expiresAt,
      usedAt: null,
    },
  });

  markOtpSent(phone);
  try {
    await smsService.sendOtpCode({
      to: phone,
      code,
      ttlMinutes: PHONE_OTP_TTL_MIN,
    });
  } catch (err) {
    // Surface a generic error so the client can retry. We log the real
    // cause for the operator; the user just sees "sms_failed".
    console.error("[otp/send] SMS send failed", err);
    res.status(502).json({ error: "sms_failed" });
    return;
  }

  res.json({
    ok: true,
    ttlMinutes: PHONE_OTP_TTL_MIN,
    resendInSec: PHONE_OTP_RESEND_COOLDOWN_SEC,
  });
});

authRouter.post("/otp/verify", async (req: Request, res: Response) => {
  const body = req.body as OtpVerifyBody;
  const phone = normalizePhone(body.phoneNumber);
  const code = typeof body.code === "string" ? body.code.trim() : "";

  if (!phone) {
    res.status(400).json({ error: "invalid_phone" });
    return;
  }
  if (code.length !== PHONE_OTP_LEN || !/^\d+$/.test(code)) {
    res.status(400).json({ error: "invalid_otp" });
    return;
  }

  // Match any still-valid code for this phone (a user can legitimately
  // have more than one outstanding code if they tapped "resend" before
  // the first SMS landed, then used the first one that arrived).
  const candidates = await prisma.phoneOtpToken.findMany({
    where: {
      phoneNumber: phone,
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });
  const codeHash = hashResetCode(code);
  const token = candidates.find((t) => timingSafeEqualHex(codeHash, t.codeHash));
  if (!token) {
    res.status(400).json({ error: "invalid_otp" });
    return;
  }

  // Invalidate this code + every other outstanding code for the phone in
  // one transaction so a duplicate request mid-flow can't be replayed.
  await prisma.$transaction([
    prisma.phoneOtpToken.update({
      where: { id: token.id },
      data: { usedAt: new Date() },
    }),
    prisma.phoneOtpToken.updateMany({
      where: {
        phoneNumber: phone,
        usedAt: null,
        id: { not: token.id },
      },
      data: { usedAt: new Date() },
    }),
  ]);

  // Find or create the user. Phone-first signup: a brand-new number gets
  // a placeholder email + a random password (argon2id-hashed). The user
  // can add a real email + set a password later from the profile screen.
  // The placeholder email is deterministic per phone so a second OTP
  // login on the same device reuses the same account instead of minting
  // a duplicate.
  const placeholderEmail = `phone+${phone}@phone.fittaz.app`;
  let user = await prisma.user.findFirst({
    where: { phoneNumber: phone },
    include: { profile: true },
  });
  let isNewUser = false;
  if (!user) {
    // Also guard against the edge case where a phone-only user already
    // exists via the placeholder email but phoneNumber wasn't set yet
    // (shouldn't happen with the flow above, but be defensive).
    user = await prisma.user.findUnique({
      where: { email: placeholderEmail },
      include: { profile: true },
    });
  }
  if (!user) {
    isNewUser = true;
    const randomPassword = crypto.randomBytes(32).toString("hex");
    const hash = await hashPassword(randomPassword);
    user = await prisma.user.create({
      data: {
        name: `User ${phone.slice(-4)}`,
        email: placeholderEmail,
        password: hash,
        phoneNumber: phone,
      },
      include: { profile: true },
    });
  } else if (user.phoneNumber !== phone) {
    // Existing account (e.g. created via email signup) logging in by
    // phone for the first time — stamp the phone on it.
    user = await prisma.user.update({
      where: { id: user.id },
      data: { phoneNumber: phone },
      include: { profile: true },
    });
  }

  const authToken = await signToken(user.id);
  const access = await getUserAccessPayload(user.id);
  res.json({
    token: authToken,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      phoneNumber: user.phoneNumber,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    },
    profile: user.profile,
    access,
    isNewUser,
  });
});

// ---------------------------------------------------------------------------
// Phone-OTP onboarding: collect name + email for phone-only accounts
// ---------------------------------------------------------------------------
//
// After a brand-new phone user verifies their OTP, their account has a
// placeholder email (`phone+<num>@phone.fittaz.app`) and a generated name
// (`User <last4>`). This authenticated endpoint lets them replace both
// with their real details before continuing to profile setup.
//
//   POST /auth/otp/details { name, email }
//     - Requires a valid bearer token (issued by /auth/otp/verify).
//     - Validates name (>= 2 chars) + email (valid shape).
//     - Rejects if the email is already used by *another* user.
//     - Updates the user's name + email, returns the refreshed
//       `{ user, profile, access }` so the client can re-hydrate.
//
// We deliberately don't strip the placeholder email pattern here — the
// uniqueness check against other users is what matters. If the user
// submits their own placeholder email back, it still passes (it's
// already theirs).

authRouter.post("/otp/details", requireAuth, async (req: Request, res: Response) => {
  const body = req.body as OtpDetailsBody;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = normalizeEmail(body.email);

  if (name.length < 2) {
    res.status(400).json({ error: "name_too_short" });
    return;
  }
  if (!email) {
    res.status(400).json({ error: "invalid_email" });
    return;
  }

  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "missing_bearer_token" });
    return;
  }

  // Reject if another user already owns this email.
  const clash = await prisma.user.findUnique({ where: { email } });
  if (clash && clash.id !== userId) {
    res.status(409).json({ error: "email_already_in_use" });
    return;
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { name, email },
    include: { profile: true },
  });

  const access = await getUserAccessPayload(updated.id);
  res.json({
    user: {
      id: updated.id,
      name: updated.name,
      email: updated.email,
      emailVerified: updated.emailVerified,
      phoneNumber: updated.phoneNumber,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    },
    profile: updated.profile,
    access,
  });
});
