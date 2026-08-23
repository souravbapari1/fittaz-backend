import { Router } from "express";
import type { Request, Response } from "express";
import crypto from "node:crypto";
import { getUserAccessPayload } from "../lib/access_features.ts";
import { prisma } from "../lib/prisma.ts";
import { hashPassword, signToken, verifyPassword } from "../lib/auth.ts";
import { emailService } from "../lib/email.ts";

export const authRouter: Router = Router();

// Password-reset OTP knobs. Centralised so the email template and the route
// agree about TTL without having to pass it around explicitly.
const RESET_CODE_TTL_MIN = 15;
const RESET_CODE_LEN = 6;

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
