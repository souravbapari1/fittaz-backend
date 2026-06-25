// Workout completion tracking — marks planned sessions done and
// aggregates calories burned for the day.
//
//   GET  /workout-completion/today  → today's completion + burn totals
//   GET  /workout-completion/day      → same for a specific plan day
//   POST /workout-completion/toggle   → mark / unmark a session

import type { Request, Response } from "express";
import { Router } from "express";

import { prisma } from "../lib/prisma.ts";
import { requireAuth } from "../middleware/require_auth.ts";

export const workoutCompletionRouter: Router = Router();
workoutCompletionRouter.use(requireAuth);

interface SessionPayload {
  title?: unknown;
  type?: unknown;
  durationMin?: unknown;
  intensity?: unknown;
}

function num(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/** Rough kcal/min by intensity — good enough for dashboard burn stats. */
export function estimateCaloriesBurned(
  durationMin: number,
  intensity: string,
  sessionType: string,
): number {
  const baseRate =
    intensity === "easy"
      ? 4
      : intensity === "hard"
        ? 10
        : 7;
  const typeBoost =
    sessionType === "cardio" || sessionType === "hiit"
      ? 1.15
      : sessionType === "mobility" || sessionType === "yoga"
        ? 0.75
        : 1;
  return Math.max(0, Math.round(durationMin * baseRate * typeBoost));
}

function calendarDate(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function planDateFor(weekStart: Date, dayIndex: number): Date {
  const start = calendarDate(weekStart);
  start.setDate(start.getDate() + dayIndex);
  return start;
}

function dayIndexForToday(weekStart: Date, weekEnd: Date): number | null {
  const today = calendarDate(new Date());
  const start = calendarDate(weekStart);
  const end = calendarDate(weekEnd);
  if (today < start || today > end) return null;
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((today.getTime() - start.getTime()) / msPerDay);
}

function sessionCountForDay(plan: unknown, dayIndex: number): number {
  if (!plan || typeof plan !== "object") return 0;
  const days = (plan as { days?: unknown }).days;
  if (!Array.isArray(days)) return 0;
  const day = days.find(
    (d) =>
      d &&
      typeof d === "object" &&
      (d as { dayIndex?: number }).dayIndex === dayIndex,
  );
  if (!day || typeof day !== "object") return 0;
  if ((day as { isRestDay?: boolean }).isRestDay) return 0;
  const sessions = (day as { sessions?: unknown }).sessions;
  return Array.isArray(sessions) ? sessions.length : 0;
}

function plannedBurnForDay(plan: unknown, dayIndex: number): number {
  if (!plan || typeof plan !== "object") return 0;
  const days = (plan as { days?: unknown }).days;
  if (!Array.isArray(days)) return 0;
  const day = days.find(
    (d) =>
      d &&
      typeof d === "object" &&
      (d as { dayIndex?: number }).dayIndex === dayIndex,
  );
  if (!day || typeof day !== "object") return 0;
  const sessions = (day as { sessions?: unknown[] }).sessions;
  if (!Array.isArray(sessions)) return 0;
  return sessions.reduce((acc, raw) => {
    if (!raw || typeof raw !== "object") return acc;
    const s = raw as SessionPayload & { type?: string };
    const durationMin = num(s.durationMin);
    const intensity =
      typeof s.intensity === "string" ? s.intensity : "moderate";
    const sessionType = typeof s.type === "string" ? s.type : "strength";
    return acc + estimateCaloriesBurned(durationMin, intensity, sessionType);
  }, 0);
}

function serializeLog(row: {
  id: string;
  sessionId: string;
  sessionTitle: string;
  sessionType: string;
  durationMin: number;
  caloriesBurned: number;
  intensity: string;
  loggedAt: Date;
}) {
  return {
    id: row.id,
    sessionId: row.sessionId,
    sessionTitle: row.sessionTitle,
    sessionType: row.sessionType,
    durationMin: row.durationMin,
    caloriesBurned: row.caloriesBurned,
    intensity: row.intensity,
    loggedAt: row.loggedAt.toISOString(),
  };
}

async function loadDayCompletion(
  userId: string,
  workoutPlanId: string,
  dayIndex: number,
  weekStart: Date,
  planJson: unknown,
) {
  const planDate = planDateFor(weekStart, dayIndex);
  const logs = await prisma.workoutCompletionLog.findMany({
    where: { userId, workoutPlanId, planDate },
    orderBy: { loggedAt: "asc" },
  });
  const caloriesBurned = logs.reduce((sum, l) => sum + l.caloriesBurned, 0);
  const durationMin = logs.reduce((sum, l) => sum + l.durationMin, 0);
  const totalSessions = sessionCountForDay(planJson, dayIndex);
  return {
    workoutPlanId,
    dayIndex,
    planDate: planDate.toISOString().slice(0, 10),
    completedSessionIds: logs.map((l) => l.sessionId),
    completedCount: logs.length,
    totalSessions,
    caloriesBurned,
    durationMin,
    plannedCaloriesBurn: plannedBurnForDay(planJson, dayIndex),
    logs: logs.map(serializeLog),
  };
}

workoutCompletionRouter.get("/today", async (req: Request, res: Response) => {
  const plan = await prisma.aiWorkoutPlan.findFirst({
    where: {
      userId: req.userId!,
      isActive: true,
      status: "published",
    },
    orderBy: { publishedAt: "desc" },
  });

  if (!plan) {
    res.json({
      hasPlan: false,
      dayIndex: null,
      completedCount: 0,
      totalSessions: 0,
      caloriesBurned: 0,
      durationMin: 0,
      plannedCaloriesBurn: 0,
      logs: [],
    });
    return;
  }

  const dayIndex = dayIndexForToday(plan.weekStart, plan.weekEnd);
  if (dayIndex === null) {
    res.json({
      hasPlan: true,
      workoutPlanId: plan.id,
      inPlanWeek: false,
      dayIndex: null,
      completedCount: 0,
      totalSessions: 0,
      caloriesBurned: 0,
      durationMin: 0,
      plannedCaloriesBurn: 0,
      logs: [],
    });
    return;
  }

  const day = await loadDayCompletion(
    req.userId!,
    plan.id,
    dayIndex,
    plan.weekStart,
    plan.plan,
  );
  res.json({ hasPlan: true, inPlanWeek: true, ...day });
});

workoutCompletionRouter.get("/day", async (req: Request, res: Response) => {
  const workoutPlanId =
    typeof req.query.workoutPlanId === "string"
      ? req.query.workoutPlanId.trim()
      : "";
  const dayIndexRaw =
    typeof req.query.dayIndex === "string"
      ? Number(req.query.dayIndex)
      : Number.NaN;

  if (
    !workoutPlanId ||
    !Number.isInteger(dayIndexRaw) ||
    dayIndexRaw < 0 ||
    dayIndexRaw > 6
  ) {
    res.status(400).json({
      error: "invalid_query",
      message: "Provide workoutPlanId and dayIndex (0–6).",
    });
    return;
  }

  const plan = await prisma.aiWorkoutPlan.findFirst({
    where: { id: workoutPlanId, userId: req.userId! },
  });
  if (!plan) {
    res.status(404).json({ error: "plan_not_found" });
    return;
  }

  const day = await loadDayCompletion(
    req.userId!,
    plan.id,
    dayIndexRaw,
    plan.weekStart,
    plan.plan,
  );
  res.json(day);
});

workoutCompletionRouter.post("/toggle", async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const workoutPlanId =
    typeof body.workoutPlanId === "string" ? body.workoutPlanId.trim() : "";
  const sessionId =
    typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  const dayIndex = num(body.dayIndex, -1);
  const completed = body.completed === true;

  if (
    !workoutPlanId ||
    !sessionId ||
    !Number.isInteger(dayIndex) ||
    dayIndex < 0 ||
    dayIndex > 6
  ) {
    res.status(400).json({
      error: "invalid_body",
      message: "Provide workoutPlanId, dayIndex (0–6), sessionId, completed.",
    });
    return;
  }

  const plan = await prisma.aiWorkoutPlan.findFirst({
    where: { id: workoutPlanId, userId: req.userId! },
  });
  if (!plan) {
    res.status(404).json({ error: "plan_not_found" });
    return;
  }

  const planDate = planDateFor(plan.weekStart, dayIndex);

  if (!completed) {
    await prisma.workoutCompletionLog.deleteMany({
      where: {
        userId: req.userId!,
        workoutPlanId,
        planDate,
        sessionId,
      },
    });
  } else {
    const session =
      body.session && typeof body.session === "object"
        ? (body.session as SessionPayload)
        : {};
    const durationMin = Math.max(0, Math.round(num(session.durationMin)));
    const intensity =
      typeof session.intensity === "string"
        ? session.intensity.slice(0, 32)
        : "moderate";
    const sessionType =
      typeof session.type === "string"
        ? session.type.slice(0, 32)
        : "strength";
    const sessionTitle =
      typeof session.title === "string"
        ? session.title.slice(0, 200)
        : "";
    const caloriesBurned = estimateCaloriesBurned(
      durationMin,
      intensity,
      sessionType,
    );

    await prisma.workoutCompletionLog.upsert({
      where: {
        userId_workoutPlanId_planDate_sessionId: {
          userId: req.userId!,
          workoutPlanId,
          planDate,
          sessionId,
        },
      },
      create: {
        userId: req.userId!,
        workoutPlanId,
        planDate,
        dayIndex,
        sessionId,
        sessionTitle,
        sessionType,
        durationMin,
        caloriesBurned,
        intensity,
      },
      update: {
        dayIndex,
        sessionTitle,
        sessionType,
        durationMin,
        caloriesBurned,
        intensity,
        loggedAt: new Date(),
      },
    });
  }

  const day = await loadDayCompletion(
    req.userId!,
    plan.id,
    dayIndex,
    plan.weekStart,
    plan.plan,
  );
  res.json(day);
});
