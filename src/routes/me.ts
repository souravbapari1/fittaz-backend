import { Router } from "express";
import type { Request, Response } from "express";
import crypto from "node:crypto";

import { getUserAccessPayload } from "../lib/access_features.ts";
import { scheduleMealPlanForNewUser } from "../jobs/weekly_meal_plans.ts";
import { scheduleWorkoutPlanForNewUser } from "../jobs/workout_plans.ts";
import { emailService } from "../lib/email.ts";
import { prisma } from "../lib/prisma.ts";
import { hydrateWorkoutPlan } from "../lib/workout_plan_hydrate.ts";
import { requireAuth } from "../middleware/require_auth.ts";

export const meRouter: Router = Router();
meRouter.use(requireAuth);

// Email-verification OTP knobs. Mirror the password-reset constants in
// auth.ts so users have the same UX expectations across both flows.
const VERIFY_CODE_TTL_MIN = 15;
const VERIFY_CODE_LEN = 6;

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

// Allowed enum values for free-form string columns. Kept here (not in the
// schema) so we can evolve the enum without a migration; the client is the
// source of truth for the labels.
const VALID_GOALS = new Set([
  "loseWeight",
  "buildMuscle",
  "maintain",
  "endurance",
  "generalFitness",
]);
const VALID_GENDERS = new Set(["male", "female", "nonBinary", "preferNotToSay"]);
const VALID_DIETS = new Set([
  "vegetarian",
  "nonVegetarian",
  "vegan",
  "eggetarian",
  "pescatarian",
  "jain",
]);
const VALID_BLOOD = new Set([
  "aPositive",
  "aNegative",
  "bPositive",
  "bNegative",
  "abPositive",
  "abNegative",
  "oPositive",
  "oNegative",
  "unknown",
]);
const VALID_WEIGHT_UNITS = new Set(["kg", "lb"]);
const VALID_HEIGHT_UNITS = new Set(["cm", "ft"]);

interface ProfileBody {
  goal?: unknown;
  goals?: unknown; // string[] — multi-select; `goal` is kept as goals[0]
  gender?: unknown;
  dob?: unknown; // ISO 8601 string
  heightCm?: unknown;
  weightKg?: unknown;
  targetWeightKg?: unknown;
  diet?: unknown;
  bloodGroup?: unknown;
  allergies?: unknown;
  weightUnit?: unknown;
  heightUnit?: unknown;
  about?: unknown;
}

function pickString(value: unknown, allowed: Set<string>): string | null {
  if (typeof value !== "string") return null;
  return allowed.has(value) ? value : null;
}

/// Filter an incoming array down to the values we recognise, de-duplicated
/// and order-preserving. Unknown entries are dropped rather than rejecting
/// the whole request, so a newer client shipping an extra goal can't 400 an
/// older server.
function pickEnumArray(
  value: unknown,
  allowed: Set<string>,
  max = 16,
): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string" || !allowed.has(v) || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

function pickPositiveNumber(value: unknown, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value <= 0 || value > max) return null;
  return value;
}

function pickDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  // Reject obviously bogus DOBs (future or before 1900).
  const now = Date.now();
  if (d.getTime() > now) return null;
  if (d.getUTCFullYear() < 1900) return null;
  return d;
}

function pickStringArray(value: unknown, max = 32): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .slice(0, max)
    .map((v) => v.trim());
}

meRouter.get("/", async (req: Request, res: Response) => {
  const [user, access] = await Promise.all([
    prisma.user.findUnique({
      where: { id: req.userId! },
      select: { ...userSelect, profile: true },
    }),
    getUserAccessPayload(req.userId!),
  ]);
  if (!user) {
    res.status(404).json({ error: "user_not_found" });
    return;
  }
  const { profile, ...userFields } = user;
  res.json({ user: userFields, profile, access });
});

// ---------------------------------------------------------------------------
// GET /me/meal-plan — active AI meal plan for the signed-in user
// ---------------------------------------------------------------------------
//
// Returns the single `isActive` plan an admin published, or `null` when
// none exists. The Flutter Meals tab calls this on load.
meRouter.get("/meal-plan", async (req: Request, res: Response) => {
  const row = await prisma.aiMealPlan.findFirst({
    where: { userId: req.userId!, isActive: true, status: "published" },
    orderBy: { publishedAt: "desc" },
    select: {
      id: true,
      title: true,
      weekStart: true,
      weekEnd: true,
      plan: true,
      notes: true,
      publishedAt: true,
    },
  });

  if (!row) {
    res.json({ mealPlan: null });
    return;
  }

  res.json({
    mealPlan: {
      id: row.id,
      title: row.title,
      weekStart: row.weekStart.toISOString(),
      weekEnd: row.weekEnd.toISOString(),
      notes: row.notes,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      plan: row.plan,
    },
  });
});

// ---------------------------------------------------------------------------
// GET /me/workout-plan — active admin-published weekly workout plan
// ---------------------------------------------------------------------------
meRouter.get("/workout-plan", async (req: Request, res: Response) => {
  const row = await prisma.aiWorkoutPlan.findFirst({
    where: { userId: req.userId!, isActive: true, status: "published" },
    orderBy: { publishedAt: "desc" },
    select: {
      id: true,
      title: true,
      weekStart: true,
      weekEnd: true,
      plan: true,
      notes: true,
      publishedAt: true,
    },
  });

  if (!row) {
    res.json({ workoutPlan: null });
    return;
  }

  const plan = await hydrateWorkoutPlan(row.plan);

  res.json({
    workoutPlan: {
      id: row.id,
      title: row.title,
      weekStart: row.weekStart.toISOString(),
      weekEnd: row.weekEnd.toISOString(),
      notes: row.notes,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      plan,
    },
  });
});

// ---------------------------------------------------------------------------
// GET /me/subscriptions — currently-active plans for the signed-in user
// ---------------------------------------------------------------------------
//
// Drives the "already owned" UI on the packages catalog + the disabled
// state on the package-details Buy button. We surface only rows whose
// `endDate` is in the future: an expired (or refunded) plan is no
// longer a hold on a fresh purchase, so the client should let the
// user buy again.
//
// Lifetime plans serialise with `isLifetime: true` and an end date in
// the year 9999 — clients render that as "Lifetime" instead of trying
// to print "active until 31 Dec 9999".
meRouter.get("/subscriptions", async (req: Request, res: Response) => {
  const now = new Date();
  const rows = await prisma.mealActivePlan.findMany({
    where: {
      userId: req.userId!,
      // `gt` (not `gte`) so a plan that expires exactly at this
      // instant doesn't keep blocking the next purchase. Practical
      // impact is nil; correctness is nicer.
      endDate: { gt: now },
    },
    orderBy: { endDate: "desc" },
    select: {
      id: true,
      startDate: true,
      endDate: true,
      plansId: true,
      plan: {
        select: {
          id: true,
          name: true,
          expirationDuration: true,
        },
      },
    },
  });

  const subscriptions = rows.map((row) => ({
    id: row.id,
    planId: row.plansId,
    planName: row.plan.name,
    expirationDuration: row.plan.expirationDuration,
    isLifetime: row.plan.expirationDuration === "lifetime",
    startDate: row.startDate.toISOString(),
    endDate: row.endDate.toISOString(),
  }));

  res.json({ subscriptions });
});

// ---------------------------------------------------------------------------
// GET /me/access — unlocked feature flags for the signed-in user
// ---------------------------------------------------------------------------
meRouter.get("/access", async (req: Request, res: Response) => {
  const access = await getUserAccessPayload(req.userId!);
  res.json({ access });
});

// ---------------------------------------------------------------------------
// PATCH /me — update editable contact / bio fields
// ---------------------------------------------------------------------------
//
// Only the small set of "info you can change without redoing onboarding"
// lives here:
//   - User.name              (required >= 2 chars when present)
//   - User.phoneNumber       (free-form string, basic shape check; null/empty
//                             to clear)
//   - User.profilePictureUrl (must be a `/files/images/...` URL; null/empty
//                             to clear)
//   - Profile.about          (up to 500 chars; null/empty to clear)
//
// Body fields are all optional — the client sends only what it wants
// to change. Missing keys are left untouched. Empty / explicit-null
// values on phoneNumber and about are treated as "clear this field"
// (so a user can remove their phone or bio without us inventing a
// separate delete endpoint).
//
// Profile-level fields that affect the meal/workout engine (goal,
// height, weight, diet, etc.) still go through PUT /me/profile so the
// validation rules stay in one place.
interface UpdateInfoBody {
  name?: unknown;
  phoneNumber?: unknown;
  profilePictureUrl?: unknown;
  about?: unknown;
}

const PHONE_MAX = 24;
const NAME_MAX = 80;
const ABOUT_MAX = 500;
// Permissive: digits, spaces, dashes, parens, leading `+`. We don't try to
// be smart about regional dial plans — that's a job for libphonenumber,
// which we'd add when WhatsApp / SMS reachability matters.
const PHONE_RE = /^[+0-9 ()\-]{7,24}$/;

/**
 * Normalise an uploaded image URL to the canonical site-relative form
 * `/files/images/<name>`, or return null if it's not a valid image asset.
 *
 * Tolerates absolute URLs, an optional proxy mount prefix (the app hits
 * the backend through the admin's `/backend-api` proxy, so uploaded URLs
 * come back as `/backend-api/files/images/...`), and already-relative
 * paths. Storing the relative form keeps records host/proxy agnostic.
 */
function normalizeImageUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  let path: string;
  try {
    path = url.startsWith("http")
      ? new URL(url).pathname
      : url.startsWith("/")
        ? url
        : `/${url}`;
  } catch {
    return null;
  }
  const match = /\/files\/images\/([A-Za-z0-9_-]+\.[A-Za-z0-9]+)$/.exec(path);
  return match ? `/files/images/${match[1]}` : null;
}

meRouter.patch("/", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as UpdateInfoBody;
  const missing: string[] = [];

  // ---- Name ---------------------------------------------------------------
  // Provided keys are kept as-is; absent keys are ignored.
  let nextName: string | undefined;
  if (body.name !== undefined) {
    if (typeof body.name !== "string") {
      missing.push("name");
    } else {
      const trimmed = body.name.trim();
      if (trimmed.length < 2 || trimmed.length > NAME_MAX) {
        missing.push("name");
      } else {
        nextName = trimmed;
      }
    }
  }

  // ---- Phone --------------------------------------------------------------
  // `null` or empty string → clear. A non-empty string must match PHONE_RE.
  let nextPhone: string | null | undefined;
  if (body.phoneNumber !== undefined) {
    if (body.phoneNumber === null) {
      nextPhone = null;
    } else if (typeof body.phoneNumber !== "string") {
      missing.push("phoneNumber");
    } else {
      const trimmed = body.phoneNumber.trim();
      if (trimmed.length === 0) {
        nextPhone = null;
      } else if (!PHONE_RE.test(trimmed) || trimmed.length > PHONE_MAX) {
        missing.push("phoneNumber");
      } else {
        nextPhone = trimmed;
      }
    }
  }

  // ---- Profile picture ----------------------------------------------------
  // `null` or empty string → clear. A non-empty string must be an
  // `/files/images/...` URL returned by the uploads service.
  let nextProfilePictureUrl: string | null | undefined;
  if (body.profilePictureUrl !== undefined) {
    if (body.profilePictureUrl === null) {
      nextProfilePictureUrl = null;
    } else if (typeof body.profilePictureUrl !== "string") {
      missing.push("profilePictureUrl");
    } else {
      const trimmed = body.profilePictureUrl.trim();
      if (trimmed.length === 0) {
        nextProfilePictureUrl = null;
      } else {
        const normalized = normalizeImageUrl(trimmed);
        if (normalized === null) {
          missing.push("profilePictureUrl");
        } else {
          nextProfilePictureUrl = normalized;
        }
      }
    }
  }

  // ---- About --------------------------------------------------------------
  let nextAbout: string | null | undefined;
  if (body.about !== undefined) {
    if (body.about === null) {
      nextAbout = null;
    } else if (typeof body.about !== "string") {
      missing.push("about");
    } else {
      const trimmed = body.about.trim();
      if (trimmed.length === 0) {
        nextAbout = null;
      } else if (trimmed.length > ABOUT_MAX) {
        missing.push("about");
      } else {
        nextAbout = trimmed;
      }
    }
  }

  if (missing.length > 0) {
    res.status(400).json({ error: "invalid_info", missing });
    return;
  }

  // No keys provided at all — nothing to do, but don't 4xx the client
  // for a no-op (could happen if the client diff'd to nothing).
  if (
    nextName === undefined &&
    nextPhone === undefined &&
    nextProfilePictureUrl === undefined &&
    nextAbout === undefined
  ) {
    const [user, access] = await Promise.all([
      prisma.user.findUnique({
        where: { id: req.userId! },
        select: { ...userSelect, profile: true },
      }),
      getUserAccessPayload(req.userId!),
    ]);
    if (!user) {
      res.status(404).json({ error: "user_not_found" });
      return;
    }
    const { profile, ...userFields } = user;
    res.json({ user: userFields, profile, access });
    return;
  }

  // ---- Persist ------------------------------------------------------------
  // Two writes (User + Profile) in one transaction so a partial DB error
  // can't leave the caller's UI showing only half the new info.
  //
  // `about` is on Profile, not User — if the user hasn't completed
  // onboarding yet there's no Profile row to update, so we skip that
  // write rather than auto-creating a half-empty Profile (which would
  // then bypass PUT /me/profile's required-field validation).
  const hasUserUpdate =
    nextName !== undefined ||
    nextPhone !== undefined ||
    nextProfilePictureUrl !== undefined;
  const hasAboutUpdate = nextAbout !== undefined;

  await prisma.$transaction(async (tx) => {
    if (hasUserUpdate) {
      await tx.user.update({
        where: { id: req.userId! },
        data: {
          ...(nextName !== undefined ? { name: nextName } : {}),
          ...(nextPhone !== undefined ? { phoneNumber: nextPhone } : {}),
          ...(nextProfilePictureUrl !== undefined
            ? { profilePictureUrl: nextProfilePictureUrl }
            : {}),
        },
      });
    }
    if (hasAboutUpdate) {
      const profile = await tx.profile.findUnique({
        where: { userId: req.userId! },
        select: { id: true },
      });
      if (profile) {
        await tx.profile.update({
          where: { userId: req.userId! },
          data: { about: nextAbout },
        });
      }
      // If no profile exists yet we silently drop the about update.
      // The client gates the field behind onboarding completion, so
      // hitting this branch shouldn't happen; leaving it silent is
      // friendlier than 4xx-ing in the rare race.
    }
  });

  const [fresh, access] = await Promise.all([
    prisma.user.findUnique({
      where: { id: req.userId! },
      select: { ...userSelect, profile: true },
    }),
    getUserAccessPayload(req.userId!),
  ]);
  if (!fresh) {
    res.status(404).json({ error: "user_not_found" });
    return;
  }
  const { profile, ...userFields } = fresh;
  res.json({ user: userFields, profile, access });
});

meRouter.put("/profile", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as ProfileBody;

  // Multi-select: prefer `goals`, but fall back to a lone `goal` so clients
  // released before the multi-select flow keep working unchanged.
  const singleGoal = pickString(body.goal, VALID_GOALS);
  const goalsInput = pickEnumArray(body.goals, VALID_GOALS);
  const goals =
    goalsInput.length > 0 ? goalsInput : singleGoal ? [singleGoal] : [];
  const goal = goals[0] ?? null;
  const gender = pickString(body.gender, VALID_GENDERS);
  const diet = pickString(body.diet, VALID_DIETS);
  const bloodGroup = pickString(body.bloodGroup, VALID_BLOOD);
  const dob = pickDate(body.dob);
  const heightCm = pickPositiveNumber(body.heightCm, 300);
  const weightKg = pickPositiveNumber(body.weightKg, 500);
  const targetWeightKg = pickPositiveNumber(body.targetWeightKg, 500);
  const weightUnit =
    pickString(body.weightUnit, VALID_WEIGHT_UNITS) ?? "kg";
  const heightUnit =
    pickString(body.heightUnit, VALID_HEIGHT_UNITS) ?? "cm";
  const allergies = pickStringArray(body.allergies);
  const about =
    typeof body.about === "string" && body.about.trim().length > 0
      ? body.about.trim().slice(0, 500)
      : null;

  const missing: string[] = [];
  if (!goal) missing.push("goal");
  if (!gender) missing.push("gender");
  if (!dob) missing.push("dob");
  if (heightCm == null) missing.push("heightCm");
  if (weightKg == null) missing.push("weightKg");
  if (targetWeightKg == null) missing.push("targetWeightKg");
  if (!diet) missing.push("diet");
  if (!bloodGroup) missing.push("bloodGroup");
  if (missing.length > 0) {
    res.status(400).json({ error: "invalid_profile", missing });
    return;
  }

  const data = {
    goal: goal!,
    goals,
    gender: gender!,
    dob: dob!,
    heightCm: heightCm!,
    weightKg: weightKg!,
    targetWeightKg: targetWeightKg!,
    diet: diet!,
    bloodGroup: bloodGroup!,
    allergies,
    weightUnit,
    heightUnit,
    about,
  };

  const userId = req.userId!;
  const hadProfile = await prisma.profile.findUnique({
    where: { userId },
    select: { id: true },
  });

  const profile = await prisma.profile.upsert({
    where: { userId },
    create: { ...data, user: { connect: { id: userId } } },
    update: data,
  });

  // First time this user has answered the onboarding questions: build
  // both of their week-one plans. Fire-and-forget — each takes an OpenAI
  // round trip and the client shouldn't wait on either to finish saving
  // a profile. They run independently, so a failure in one (or an empty
  // exercise catalog) still leaves the other published.
  if (!hadProfile) {
    scheduleMealPlanForNewUser(userId);
    scheduleWorkoutPlanForNewUser(userId);
  }

  res.json({ profile });
});

// ---------------------------------------------------------------------------
// Email verification (OTP-based)
// ---------------------------------------------------------------------------
//
// Two-step flow, both endpoints require an authenticated session
// (handled by the `meRouter.use(requireAuth)` above):
//
//   1. POST /me/email-verification/request
//        - Mints a fresh 6-digit code for the current user, stores its
//          SHA-256 hash with a 15-min expiry, and dispatches the code
//          via `emailService.sendEmailVerificationCode(...)`.
//        - No-ops with 200 if the user is already verified — the
//          banner UI hides itself once the auth state catches up but
//          the network round-trip might race.
//
//   2. POST /me/email-verification/confirm { code }
//        - Looks up the most recent unused, unexpired token for the
//          user and compares the SHA-256 hash of the submitted code
//          in constant time.
//        - On success: stamps `User.emailVerified = now`, marks the
//          token used, and invalidates every other outstanding code
//          for the user.
//
// Same hash/expiry/replay-prevention guarantees as the password-reset
// flow. The DB model is a parallel table (`EmailVerificationToken`)
// so the two OTP lifecycles can evolve independently.

/** Numeric, zero-padded OTP. Crypto-random so it isn't guessable. */
function generateVerifyCode(): string {
  const max = 10 ** VERIFY_CODE_LEN;
  return crypto.randomInt(0, max).toString().padStart(VERIFY_CODE_LEN, "0");
}

/** SHA-256 of the code. We only ever persist the hash, never the code. */
function hashVerifyCode(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}

/** Constant-time compare of two hex digests. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

meRouter.post(
  "/email-verification/request",
  async (req: Request, res: Response) => {
    const user = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: { id: true, email: true, emailVerified: true },
    });
    if (!user) {
      res.status(404).json({ error: "user_not_found" });
      return;
    }
    if (user.emailVerified) {
      // Idempotent: already done, nothing to send. We don't 4xx here
      // because the client UI may legitimately race the auth state.
      res.json({ ok: true, alreadyVerified: true, ttlMinutes: VERIFY_CODE_TTL_MIN });
      return;
    }

    const code = generateVerifyCode();
    const expiresAt = new Date(Date.now() + VERIFY_CODE_TTL_MIN * 60_000);
    await prisma.emailVerificationToken.create({
      data: {
        codeHash: hashVerifyCode(code),
        userId: user.id,
        expiresAt,
      },
    });

    try {
      await emailService.sendEmailVerificationCode({
        to: user.email,
        code,
        ttlMinutes: VERIFY_CODE_TTL_MIN,
      });
    } catch (err) {
      // Log but don't fail the request — user can retry from the UI
      // (Resend button), and the code is already persisted so it'll
      // accept whatever the user eventually pulls from their inbox.
      console.error("[verify-email] send failed", err);
    }

    res.json({ ok: true, ttlMinutes: VERIFY_CODE_TTL_MIN });
  },
);

meRouter.post(
  "/email-verification/confirm",
  async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { code?: unknown };
    const code = typeof body.code === "string" ? body.code.trim() : "";

    console.log(code);
    console.log(body);



    if (code.length !== VERIFY_CODE_LEN || !/^\d+$/.test(code)) {
      console.log("Isshue 1");

      res.status(400).json({ error: "invalid_verification_code" });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: { id: true, emailVerified: true },
    });
    if (!user) {
      res.status(404).json({ error: "user_not_found" });
      return;
    }
    if (user.emailVerified) {
      // Already verified — return the cached timestamp so the client
      // can hydrate without a separate /me call.
      res.json({ ok: true, alreadyVerified: true, emailVerified: user.emailVerified });
      return;
    }

    // Check every still-valid code, not just the newest one. The client
    // auto-requests a fresh code on mount (and again on Resend), so it's
    // routine for more than one outstanding code to exist at once — e.g.
    // the screen remounts and sends code B while the user is still typing
    // code A from their inbox. Only matching against the latest token
    // would reject A as "invalid" even though it's unused and unexpired.
    const candidates = await prisma.emailVerificationToken.findMany({
      where: {
        userId: user.id,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
    });
    const codeHash = hashVerifyCode(code);
    const token = candidates.find((t) =>
      timingSafeEqualHex(codeHash, t.codeHash),
    );
    console.log({
      codeHash,
      db: token
    });

    if (!token) {
      console.log("Isshue 2");
      res.status(400).json({ error: "invalid_verification_code" });
      return;
    }

    const now = new Date();
    // Stamp verification + burn every outstanding code in one
    // transaction so a duplicate-code request mid-flow can't be
    // replayed after the user is already verified.
    const [updated] = await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { emailVerified: now },
        select: { emailVerified: true },
      }),
      prisma.emailVerificationToken.update({
        where: { id: token.id },
        data: { usedAt: now },
      }),
      prisma.emailVerificationToken.updateMany({
        where: {
          userId: user.id,
          usedAt: null,
          id: { not: token.id },
        },
        data: { usedAt: now },
      }),
    ]);

    res.json({ ok: true, emailVerified: updated.emailVerified });
  },
);
