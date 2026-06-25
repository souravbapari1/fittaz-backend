// Hydration tracking + reminder settings.
//
// Endpoints (all require auth — mounted under /water with requireAuth):
//
//   GET  /water/today                  → today's progress + settings + logs
//   GET  /water/history?days=7         → daily totals for the last N days
//   PUT  /water/settings               → upsert reminder + goal preferences
//   POST /water/logs                   → add a log { amountMl, loggedAt? }
//   DELETE /water/logs/:id             → undo a log
//
// "Today" is computed in the server's local timezone — the same day
// boundary the client uses when it draws the progress ring. If we
// ever go multi-region we'll need a per-user IANA tz column; until
// then the API and the home dashboard agree on midnight, which is
// what users notice.
//
// Reminder *scheduling* is owned by the Flutter client (via
// `flutter_local_notifications`). The backend just stores the
// preferences so they survive reinstall and so multiple devices
// converge on the same cadence.

import type { Request, Response } from "express";
import { Router } from "express";

import { prisma } from "../lib/prisma.ts";
import { requireAuth } from "../middleware/require_auth.ts";

export const waterRouter: Router = Router();
waterRouter.use(requireAuth);

// ---------------------------------------------------------------------------
// Defaults & validation knobs
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = {
  dailyGoalMl: 2000,
  glassSizeMl: 250,
  remindersEnabled: true,
  startHour: 8,
  endHour: 22,
  intervalMinutes: 60,
} as const;

// Sensible upper bounds. The UI lets the user adjust within tighter
// ranges; these caps just prevent obviously-wrong values (mistyped
// "20000 ml" goal, "5 minute" reminder spam) from corrupting the
// scheduler on either side.
const LIMITS = {
  dailyGoalMl: { min: 250, max: 10_000 }, // 0.25 L – 10 L
  glassSizeMl: { min: 50, max: 2_000 },
  amountMl: { min: 10, max: 5_000 },
  startHour: { min: 0, max: 23 },
  endHour: { min: 0, max: 23 },
  intervalMinutes: { min: 15, max: 240 }, // 15 min – 4 h
  historyDays: { min: 1, max: 90 },
} as const;

type Settings = {
  dailyGoalMl: number;
  glassSizeMl: number;
  remindersEnabled: boolean;
  startHour: number;
  endHour: number;
  intervalMinutes: number;
};

/** Clamp an integer between [lo, hi]; returns null on non-integer input. */
function clampInt(value: unknown, lo: number, hi: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const n = Math.round(value);
  if (n < lo || n > hi) return null;
  return n;
}

/** Coerce + clamp every settings field with the same rules used on insert. */
function pickSettings(body: Record<string, unknown>): {
  data: Partial<Settings>;
  invalid: string[];
} {
  const out: Partial<Settings> = {};
  const invalid: string[] = [];

  if (body.dailyGoalMl !== undefined) {
    const v = clampInt(body.dailyGoalMl, LIMITS.dailyGoalMl.min, LIMITS.dailyGoalMl.max);
    if (v == null) invalid.push("dailyGoalMl");
    else out.dailyGoalMl = v;
  }
  if (body.glassSizeMl !== undefined) {
    const v = clampInt(body.glassSizeMl, LIMITS.glassSizeMl.min, LIMITS.glassSizeMl.max);
    if (v == null) invalid.push("glassSizeMl");
    else out.glassSizeMl = v;
  }
  if (body.remindersEnabled !== undefined) {
    if (typeof body.remindersEnabled !== "boolean") invalid.push("remindersEnabled");
    else out.remindersEnabled = body.remindersEnabled;
  }
  if (body.startHour !== undefined) {
    const v = clampInt(body.startHour, LIMITS.startHour.min, LIMITS.startHour.max);
    if (v == null) invalid.push("startHour");
    else out.startHour = v;
  }
  if (body.endHour !== undefined) {
    const v = clampInt(body.endHour, LIMITS.endHour.min, LIMITS.endHour.max);
    if (v == null) invalid.push("endHour");
    else out.endHour = v;
  }
  if (body.intervalMinutes !== undefined) {
    const v = clampInt(
      body.intervalMinutes,
      LIMITS.intervalMinutes.min,
      LIMITS.intervalMinutes.max,
    );
    if (v == null) invalid.push("intervalMinutes");
    else out.intervalMinutes = v;
  }

  return { data: out, invalid };
}

// ---------------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------------

/**
 * Return the user's WaterSettings row, creating it on first access.
 *
 * Doing this in the GET path means the client always sees a fully
 * hydrated settings object — never an "edit defaults to fill in"
 * empty form — and the upsert is idempotent so concurrent first
 * reads from two devices can't double-create.
 */
async function ensureSettings(userId: string): Promise<Settings & { id: string }> {
  const settings = await prisma.waterSettings.upsert({
    where: { userId },
    create: { userId, ...DEFAULT_SETTINGS },
    update: {},
    select: {
      id: true,
      dailyGoalMl: true,
      glassSizeMl: true,
      remindersEnabled: true,
      startHour: true,
      endHour: true,
      intervalMinutes: true,
    },
  });
  return settings;
}

// ---------------------------------------------------------------------------
// Day-boundary helpers (server-local time)
// ---------------------------------------------------------------------------

/** Local midnight at the start of the day [d] lands in. */
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

/** `YYYY-MM-DD` in server-local time — used for history grouping keys. */
function localDateKey(d: Date): string {
  const yyyy = d.getFullYear().toString().padStart(4, "0");
  const mm = (d.getMonth() + 1).toString().padStart(2, "0");
  const dd = d.getDate().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * `GET /water/today`
 *
 * One-shot payload the tracker screen needs to render its first
 * frame: settings, total ml consumed today, and the individual log
 * rows ordered most-recent-first. The shape mirrors what the
 * Flutter `WaterService.fetchToday()` expects so it's a single
 * round-trip on screen open.
 */
waterRouter.get("/today", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const settings = await ensureSettings(userId);

  const dayStart = startOfDay(new Date());
  const dayEnd = addDays(dayStart, 1);

  const logs = await prisma.waterLog.findMany({
    where: { userId, loggedAt: { gte: dayStart, lt: dayEnd } },
    orderBy: { loggedAt: "desc" },
    select: { id: true, amountMl: true, loggedAt: true, createdAt: true },
  });

  const totalMl = logs.reduce((sum, l) => sum + l.amountMl, 0);

  res.json({
    settings,
    today: {
      date: localDateKey(dayStart),
      goalMl: settings.dailyGoalMl,
      totalMl,
      logs,
    },
  });
});

/**
 * `GET /water/history?days=7`
 *
 * Daily totals for the chart on the tracker screen. Returns one
 * entry per day in the window, oldest → newest, with zero-filled
 * gaps so the client can render a clean bar/area chart without
 * having to reconcile missing dates.
 */
waterRouter.get("/history", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const requested = Number(req.query.days ?? 7);
  const days =
    clampInt(requested, LIMITS.historyDays.min, LIMITS.historyDays.max) ?? 7;

  const today = startOfDay(new Date());
  // Window covers `days` consecutive days, inclusive of today on the right.
  const windowStart = addDays(today, -(days - 1));
  const windowEnd = addDays(today, 1);

  const logs = await prisma.waterLog.findMany({
    where: { userId, loggedAt: { gte: windowStart, lt: windowEnd } },
    select: { amountMl: true, loggedAt: true },
  });

  // Bucket by local-date key so DST transitions can't split a day
  // into two adjacent rows.
  const buckets = new Map<string, number>();
  for (const log of logs) {
    const key = localDateKey(log.loggedAt);
    buckets.set(key, (buckets.get(key) ?? 0) + log.amountMl);
  }

  const settings = await ensureSettings(userId);
  const out: { date: string; totalMl: number; goalMl: number }[] = [];
  for (let i = 0; i < days; i++) {
    const day = addDays(windowStart, i);
    const key = localDateKey(day);
    out.push({
      date: key,
      totalMl: buckets.get(key) ?? 0,
      goalMl: settings.dailyGoalMl,
    });
  }

  res.json({ days: out });
});

/**
 * `PUT /water/settings`
 *
 * Partial update — only fields the client sends are touched. We
 * still validate every field present and fail the whole request on
 * the first invalid one so the client can show a precise message.
 */
waterRouter.put("/settings", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { data, invalid } = pickSettings(body);

  if (invalid.length > 0) {
    res.status(400).json({ error: "invalid_water_settings", missing: invalid });
    return;
  }

  // Make sure a row exists first (so the partial update has something
  // to merge into) — without this, a brand-new user PUT-ing settings
  // before ever calling GET /today would 404.
  await ensureSettings(userId);

  const updated = await prisma.waterSettings.update({
    where: { userId },
    data,
    select: {
      id: true,
      dailyGoalMl: true,
      glassSizeMl: true,
      remindersEnabled: true,
      startHour: true,
      endHour: true,
      intervalMinutes: true,
    },
  });

  res.json({ settings: updated });
});

/**
 * `POST /water/logs`
 *
 * Add a hydration entry. Body: `{ amountMl: number, loggedAt?: string }`.
 *
 * `loggedAt` is optional — defaults to `now`. We allow backdating
 * (the user opens the app at 3pm and logs "I drank a glass at noon")
 * but reject future timestamps because nothing in the rest of the
 * stack would know what to do with them.
 *
 * Returns the freshly written log + the new running total for today,
 * so the client can update its progress ring without a follow-up
 * /today call.
 */
waterRouter.post("/logs", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const body = (req.body ?? {}) as { amountMl?: unknown; loggedAt?: unknown };

  const amountMl = clampInt(body.amountMl, LIMITS.amountMl.min, LIMITS.amountMl.max);
  if (amountMl == null) {
    res.status(400).json({ error: "invalid_water_log", missing: ["amountMl"] });
    return;
  }

  let loggedAt: Date = new Date();
  if (body.loggedAt !== undefined && body.loggedAt !== null) {
    if (typeof body.loggedAt !== "string") {
      res.status(400).json({ error: "invalid_water_log", missing: ["loggedAt"] });
      return;
    }
    const parsed = new Date(body.loggedAt);
    if (Number.isNaN(parsed.getTime())) {
      res.status(400).json({ error: "invalid_water_log", missing: ["loggedAt"] });
      return;
    }
    // Allow up to 1 minute of clock skew before declaring a timestamp "in
    // the future" — phones routinely race the server by a few hundred ms.
    if (parsed.getTime() > Date.now() + 60_000) {
      res.status(400).json({ error: "invalid_water_log", missing: ["loggedAt"] });
      return;
    }
    loggedAt = parsed;
  }

  const log = await prisma.waterLog.create({
    data: { userId, amountMl, loggedAt },
    select: { id: true, amountMl: true, loggedAt: true, createdAt: true },
  });

  // Re-aggregate today after the insert so the client doesn't have
  // to maintain its own running total. Cheap because today's logs
  // are at most ~30 rows for any sane user.
  const dayStart = startOfDay(new Date());
  const dayEnd = addDays(dayStart, 1);
  const todayLogs = await prisma.waterLog.findMany({
    where: { userId, loggedAt: { gte: dayStart, lt: dayEnd } },
    select: { amountMl: true },
  });
  const totalMl = todayLogs.reduce((sum, l) => sum + l.amountMl, 0);

  res.status(201).json({
    log,
    today: { date: localDateKey(dayStart), totalMl },
  });
});

/**
 * `DELETE /water/logs/:id`
 *
 * Undo. Limited to logs owned by the caller — a 404 (not 403) is
 * returned for "not yours" to keep the cross-account membership of
 * any log id opaque. Returns the new running total so the UI can
 * tick the progress ring back down without a /today refetch.
 */
waterRouter.delete("/logs/:id", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { id } = req.params as { id: string };

  const log = await prisma.waterLog.findUnique({
    where: { id },
    select: { id: true, userId: true },
  });
  if (!log || log.userId !== userId) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  await prisma.waterLog.delete({ where: { id } });

  const dayStart = startOfDay(new Date());
  const dayEnd = addDays(dayStart, 1);
  const todayLogs = await prisma.waterLog.findMany({
    where: { userId, loggedAt: { gte: dayStart, lt: dayEnd } },
    select: { amountMl: true },
  });
  const totalMl = todayLogs.reduce((sum, l) => sum + l.amountMl, 0);

  res.json({ ok: true, today: { date: localDateKey(dayStart), totalMl } });
});
