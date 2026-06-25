// Meal intake tracking — persists which planned meals the user ate
// and aggregates their daily nutrition from those logs.
//
//   GET  /meal-intake/today          → today's completion + intake totals
//   GET  /meal-intake/day            → same for a specific plan day
//   POST /meal-intake/toggle         → mark / unmark a meal slot

import type { Request, Response } from "express";
import { Router } from "express";

import { prisma } from "../lib/prisma.ts";
import { requireAuth } from "../middleware/require_auth.ts";

export const mealIntakeRouter: Router = Router();
mealIntakeRouter.use(requireAuth);

const VALID_SLOTS = new Set(["breakfast", "lunch", "snack", "dinner"]);

interface NutritionPayload {
  calories?: unknown;
  proteinGrams?: unknown;
  carbsGrams?: unknown;
  fatGrams?: unknown;
  fiberGrams?: unknown;
  sugarGrams?: unknown;
  saturatedFatGrams?: unknown;
  sodiumMg?: unknown;
}

function num(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function pickNutrition(raw: NutritionPayload | undefined) {
  return {
    calories: num(raw?.calories),
    proteinGrams: num(raw?.proteinGrams),
    carbsGrams: num(raw?.carbsGrams),
    fatGrams: num(raw?.fatGrams),
    fiberGrams: num(raw?.fiberGrams),
    sugarGrams: num(raw?.sugarGrams),
    saturatedFatGrams: num(raw?.saturatedFatGrams),
    sodiumMg: num(raw?.sodiumMg),
  };
}

function sumNutrition(
  rows: Array<{
    calories: number;
    proteinGrams: number;
    carbsGrams: number;
    fatGrams: number;
    fiberGrams: number;
    sugarGrams: number;
    saturatedFatGrams: number;
    sodiumMg: number;
  }>,
) {
  return rows.reduce(
    (acc, r) => ({
      calories: acc.calories + r.calories,
      proteinGrams: acc.proteinGrams + r.proteinGrams,
      carbsGrams: acc.carbsGrams + r.carbsGrams,
      fatGrams: acc.fatGrams + r.fatGrams,
      fiberGrams: acc.fiberGrams + r.fiberGrams,
      sugarGrams: acc.sugarGrams + r.sugarGrams,
      saturatedFatGrams: acc.saturatedFatGrams + r.saturatedFatGrams,
      sodiumMg: acc.sodiumMg + r.sodiumMg,
    }),
    {
      calories: 0,
      proteinGrams: 0,
      carbsGrams: 0,
      fatGrams: 0,
      fiberGrams: 0,
      sugarGrams: 0,
      saturatedFatGrams: 0,
      sodiumMg: 0,
    },
  );
}

/** Calendar date at local midnight for weekStart + dayIndex. */
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

function mealCountForDay(plan: unknown, dayIndex: number): number {
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
  const meals = (day as { meals?: unknown }).meals;
  return Array.isArray(meals) ? meals.length : 0;
}

function planTargets(plan: unknown) {
  if (!plan || typeof plan !== "object") return pickNutrition(undefined);
  const targets = (plan as { targets?: NutritionPayload }).targets;
  return pickNutrition(targets);
}

function plannedIntakeForDay(plan: unknown, dayIndex: number) {
  if (!plan || typeof plan !== "object") return pickNutrition(undefined);
  const days = (plan as { days?: unknown }).days;
  if (!Array.isArray(days)) return pickNutrition(undefined);
  const day = days.find(
    (d) =>
      d &&
      typeof d === "object" &&
      (d as { dayIndex?: number }).dayIndex === dayIndex,
  );
  if (!day || typeof day !== "object") return pickNutrition(undefined);
  const totals = (day as { dailyTotals?: NutritionPayload }).dailyTotals;
  return pickNutrition(totals);
}

function serializeLog(row: {
  id: string;
  slot: string;
  mealName: string;
  foods: string[];
  calories: number;
  proteinGrams: number;
  carbsGrams: number;
  fatGrams: number;
  fiberGrams: number;
  sugarGrams: number;
  saturatedFatGrams: number;
  sodiumMg: number;
  loggedAt: Date;
}) {
  return {
    id: row.id,
    slot: row.slot,
    mealName: row.mealName,
    foods: row.foods,
    nutrition: {
      calories: row.calories,
      proteinGrams: row.proteinGrams,
      carbsGrams: row.carbsGrams,
      fatGrams: row.fatGrams,
      fiberGrams: row.fiberGrams,
      sugarGrams: row.sugarGrams,
      saturatedFatGrams: row.saturatedFatGrams,
      sodiumMg: row.sodiumMg,
    },
    loggedAt: row.loggedAt.toISOString(),
  };
}

async function loadDayIntake(
  userId: string,
  mealPlanId: string,
  dayIndex: number,
  weekStart: Date,
  planJson: unknown,
) {
  const planDate = planDateFor(weekStart, dayIndex);
  const logs = await prisma.mealIntakeLog.findMany({
    where: { userId, mealPlanId, planDate },
    orderBy: { loggedAt: "asc" },
  });
  const intake = sumNutrition(logs);
  const totalMeals = mealCountForDay(planJson, dayIndex);
  return {
    mealPlanId,
    dayIndex,
    planDate: planDate.toISOString().slice(0, 10),
    completedSlots: logs.map((l) => l.slot),
    completedCount: logs.length,
    totalMeals,
    intake,
    targets: planTargets(planJson),
    plannedIntake: plannedIntakeForDay(planJson, dayIndex),
    logs: logs.map(serializeLog),
  };
}

/** GET /meal-intake/today — active plan + today's intake if in range. */
mealIntakeRouter.get("/today", async (req: Request, res: Response) => {
  const plan = await prisma.aiMealPlan.findFirst({
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
      totalMeals: 0,
      intake: sumNutrition([]),
      targets: pickNutrition(undefined),
      plannedIntake: pickNutrition(undefined),
      logs: [],
    });
    return;
  }

  const dayIndex = dayIndexForToday(plan.weekStart, plan.weekEnd);
  if (dayIndex === null) {
    res.json({
      hasPlan: true,
      mealPlanId: plan.id,
      inPlanWeek: false,
      dayIndex: null,
      completedCount: 0,
      totalMeals: 0,
      intake: sumNutrition([]),
      targets: planTargets(plan.plan),
      plannedIntake: pickNutrition(undefined),
      logs: [],
    });
    return;
  }

  const day = await loadDayIntake(
    req.userId!,
    plan.id,
    dayIndex,
    plan.weekStart,
    plan.plan,
  );
  res.json({ hasPlan: true, inPlanWeek: true, ...day });
});

/** GET /meal-intake/day?mealPlanId=&dayIndex= */
mealIntakeRouter.get("/day", async (req: Request, res: Response) => {
  const mealPlanId =
    typeof req.query.mealPlanId === "string" ? req.query.mealPlanId.trim() : "";
  const dayIndexRaw =
    typeof req.query.dayIndex === "string"
      ? Number(req.query.dayIndex)
      : Number.NaN;

  if (!mealPlanId || !Number.isInteger(dayIndexRaw) || dayIndexRaw < 0 || dayIndexRaw > 6) {
    res.status(400).json({
      error: "invalid_query",
      message: "Provide mealPlanId and dayIndex (0–6).",
    });
    return;
  }

  const plan = await prisma.aiMealPlan.findFirst({
    where: { id: mealPlanId, userId: req.userId! },
  });
  if (!plan) {
    res.status(404).json({ error: "plan_not_found" });
    return;
  }

  const day = await loadDayIntake(
    req.userId!,
    plan.id,
    dayIndexRaw,
    plan.weekStart,
    plan.plan,
  );
  res.json(day);
});

/** POST /meal-intake/toggle — mark or unmark a meal slot. */
mealIntakeRouter.post("/toggle", async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const mealPlanId =
    typeof body.mealPlanId === "string" ? body.mealPlanId.trim() : "";
  const dayIndex =
    typeof body.dayIndex === "number" ? Math.round(body.dayIndex) : Number.NaN;
  const slot = typeof body.slot === "string" ? body.slot.trim().toLowerCase() : "";
  const completed = body.completed === true;

  if (!mealPlanId || !VALID_SLOTS.has(slot) || !Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex > 6) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }

  const plan = await prisma.aiMealPlan.findFirst({
    where: { id: mealPlanId, userId: req.userId! },
  });
  if (!plan) {
    res.status(404).json({ error: "plan_not_found" });
    return;
  }

  const planDate = planDateFor(plan.weekStart, dayIndex);

  if (!completed) {
    await prisma.mealIntakeLog.deleteMany({
      where: {
        userId: req.userId!,
        mealPlanId,
        planDate,
        slot,
      },
    });
  } else {
    const meal =
      body.meal && typeof body.meal === "object"
        ? (body.meal as Record<string, unknown>)
        : {};
    const foods = Array.isArray(meal.foods)
      ? meal.foods.filter((f): f is string => typeof f === "string").slice(0, 32)
      : [];
    const nutrition = pickNutrition(
      meal.nutrition as NutritionPayload | undefined,
    );

    await prisma.mealIntakeLog.upsert({
      where: {
        userId_mealPlanId_planDate_slot: {
          userId: req.userId!,
          mealPlanId,
          planDate,
          slot,
        },
      },
      create: {
        userId: req.userId!,
        mealPlanId,
        planDate,
        dayIndex,
        slot,
        mealName: typeof meal.name === "string" ? meal.name.slice(0, 200) : "",
        foods,
        ...nutrition,
      },
      update: {
        dayIndex,
        mealName: typeof meal.name === "string" ? meal.name.slice(0, 200) : "",
        foods,
        ...nutrition,
        loggedAt: new Date(),
      },
    });
  }

  const day = await loadDayIntake(
    req.userId!,
    plan.id,
    dayIndex,
    plan.weekStart,
    plan.plan,
  );
  res.json(day);
});
