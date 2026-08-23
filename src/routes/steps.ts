// Daily step tracking — sync from the mobile pedometer / HealthKit /
// Health Connect feed and surface progress on the home dashboard.
//
// Endpoints (all require auth — mounted under /steps with requireAuth):
//
//   GET  /steps/today              → today's steps + goal + derived stats
//   GET  /steps/history?days=30    → daily totals for charting
//   PUT  /steps/sync               → upsert { steps, date? } from device
//   PUT  /steps/goal               → update { targetSteps }
//
// Derived metrics (calories, distance) are computed server-side so every
// client renders the same numbers. When the user has a profile weight we
// use a slightly more accurate burn estimate; otherwise we fall back to
// the common ~0.04 kcal/step rule of thumb.

import type { Request, Response } from "express";
import { Router } from "express";

import { prisma } from "../lib/prisma.ts";
import { requireAuth } from "../middleware/require_auth.ts";

export const stepsRouter: Router = Router();
stepsRouter.use(requireAuth);

const DEFAULT_TARGET_STEPS = 10_000;
const STRIDE_METERS = 0.762;
const KCAL_PER_STEP_FALLBACK = 0.04;

const LIMITS = {
  targetSteps: { min: 1_000, max: 100_000 },
  steps: { min: 0, max: 200_000 },
  historyDays: { min: 1, max: 90 },
} as const;

function clampInt(value: unknown, lo: number, hi: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const n = Math.round(value);
  if (n < lo || n > hi) return null;
  return n;
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

function localDateKey(d: Date): string {
  const yyyy = d.getFullYear().toString().padStart(4, "0");
  const mm = (d.getMonth() + 1).toString().padStart(2, "0");
  const dd = d.getDate().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseDateKey(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  const yyyy = Number(m[1]);
  const mm = Number(m[2]);
  const dd = Number(m[3]);
  const d = new Date(yyyy, mm - 1, dd);
  if (d.getFullYear() !== yyyy || d.getMonth() !== mm - 1 || d.getDate() !== dd) {
    return null;
  }
  return startOfDay(d);
}

function deriveMetrics(steps: number, weightKg: number | null) {
  const distanceKm = Math.round(((steps * STRIDE_METERS) / 1000) * 10) / 10;
  const calories =
    weightKg != null && weightKg > 0
      ? Math.round(steps * 0.0005 * weightKg * 3.5)
      : Math.round(steps * KCAL_PER_STEP_FALLBACK);
  return { calories, distanceKm };
}

async function ensureGoal(userId: string) {
  return prisma.walkGoal.upsert({
    where: { userId },
    create: { userId, targetSteps: DEFAULT_TARGET_STEPS },
    update: {},
    select: { id: true, targetSteps: true },
  });
}

async function userWeightKg(userId: string): Promise<number | null> {
  const profile = await prisma.profile.findUnique({
    where: { userId },
    select: { weightKg: true },
  });
  return profile?.weightKg ?? null;
}

function todayPayload(
  dateKey: string,
  steps: number,
  targetSteps: number,
  weightKg: number | null,
) {
  const { calories, distanceKm } = deriveMetrics(steps, weightKg);
  return {
    date: dateKey,
    steps,
    goalSteps: targetSteps,
    calories,
    distanceKm,
  };
}

stepsRouter.get("/today", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const goal = await ensureGoal(userId);
  const weightKg = await userWeightKg(userId);

  const dayStart = startOfDay(new Date());
  const dateKey = localDateKey(dayStart);

  const row = await prisma.walkProgress.findUnique({
    where: { userId_date: { userId, date: dayStart } },
    select: { steps: true },
  });

  res.json({
    goal: { targetSteps: goal.targetSteps },
    today: todayPayload(dateKey, row?.steps ?? 0, goal.targetSteps, weightKg),
  });
});

stepsRouter.get("/history", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const requested = Number(req.query.days ?? 30);
  const days =
    clampInt(requested, LIMITS.historyDays.min, LIMITS.historyDays.max) ?? 30;

  const goal = await ensureGoal(userId);
  const today = startOfDay(new Date());
  const windowStart = addDays(today, -(days - 1));
  const windowEnd = addDays(today, 1);

  const rows = await prisma.walkProgress.findMany({
    where: { userId, date: { gte: windowStart, lt: windowEnd } },
    select: { date: true, steps: true },
  });

  const buckets = new Map<string, number>();
  for (const row of rows) {
    buckets.set(localDateKey(row.date), row.steps);
  }

  const out: { date: string; steps: number; goalSteps: number }[] = [];
  for (let i = 0; i < days; i++) {
    const day = addDays(windowStart, i);
    const key = localDateKey(day);
    out.push({
      date: key,
      steps: buckets.get(key) ?? 0,
      goalSteps: goal.targetSteps,
    });
  }

  res.json({ days: out });
});

stepsRouter.put("/sync", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const body = (req.body ?? {}) as {
    steps?: unknown;
    date?: unknown;
    authoritative?: unknown;
  };

  const steps = clampInt(body.steps, LIMITS.steps.min, LIMITS.steps.max);
  if (steps == null) {
    res.status(400).json({ error: "invalid_steps_sync", missing: ["steps"] });
    return;
  }

  let dayStart = startOfDay(new Date());
  if (body.date !== undefined && body.date !== null) {
    if (typeof body.date !== "string") {
      res.status(400).json({ error: "invalid_steps_sync", missing: ["date"] });
      return;
    }
    const parsed = parseDateKey(body.date);
    if (!parsed) {
      res.status(400).json({ error: "invalid_steps_sync", missing: ["date"] });
      return;
    }
    dayStart = parsed;
  }

  const goal = await ensureGoal(userId);
  const weightKg = await userWeightKg(userId);
  const dateKey = localDateKey(dayStart);

  const existing = await prisma.walkProgress.findUnique({
    where: { userId_date: { userId, date: dayStart } },
    select: { steps: true },
  });

  // Two kinds of client, two merge rules.
  //
  // Android can only report steps since the app first ran today (the
  // step sensor counts from boot and has no history API), so its figure
  // can legitimately jump *down* — after a reboot, or a reinstall — and
  // taking the max is what stops the user's progress evaporating.
  //
  // iOS asks CoreMotion for the real midnight-to-now total, which is
  // correct for the whole day. Such a client sets `authoritative` and we
  // store exactly what it sends. Without this, a single bad reading was
  // permanent: an older build reported steps-since-reboot, and max()
  // meant nothing could ever bring that day back down.
  const authoritative = body.authoritative === true;
  const mergedSteps = authoritative
    ? steps
    : Math.max(existing?.steps ?? 0, steps);

  await prisma.walkProgress.upsert({
    where: { userId_date: { userId, date: dayStart } },
    create: {
      userId,
      date: dayStart,
      steps: mergedSteps,
      walkGoalId: goal.id,
    },
    update: { steps: mergedSteps, walkGoalId: goal.id },
  });

  res.json({
    today: todayPayload(dateKey, mergedSteps, goal.targetSteps, weightKg),
  });
});

stepsRouter.put("/goal", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const body = (req.body ?? {}) as { targetSteps?: unknown };

  const targetSteps = clampInt(
    body.targetSteps,
    LIMITS.targetSteps.min,
    LIMITS.targetSteps.max,
  );
  if (targetSteps == null) {
    res.status(400).json({ error: "invalid_steps_goal", missing: ["targetSteps"] });
    return;
  }

  await ensureGoal(userId);
  const updated = await prisma.walkGoal.update({
    where: { userId },
    data: { targetSteps },
    select: { targetSteps: true },
  });

  res.json({ goal: updated });
});
