// GET /report — personal status dashboard for the signed-in user.
//
// Aggregates today's progress, 7-day activity, active plans, and
// lifetime counters in one round-trip so the Flutter report screen
// doesn't fan out across half a dozen endpoints on load.

import type { Request, Response } from "express";
import { Router } from "express";

import { prisma } from "../lib/prisma.ts";
import { requireAuth } from "../middleware/require_auth.ts";
import { notDeleted } from "../lib/mongo_filters.ts";

export const userReportRouter: Router = Router();
userReportRouter.use(requireAuth);

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

function calendarDate(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function dayIndexForToday(weekStart: Date, weekEnd: Date): number | null {
  const today = calendarDate(new Date());
  const start = calendarDate(weekStart);
  const end = calendarDate(weekEnd);
  if (today < start || today > end) return null;
  return Math.round((today.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
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

function mealTargets(plan: unknown): { calories: number; proteinGrams: number } {
  if (!plan || typeof plan !== "object") {
    return { calories: 0, proteinGrams: 0 };
  }
  const targets = (plan as { targets?: unknown }).targets;
  if (!targets || typeof targets !== "object") {
    return { calories: 0, proteinGrams: 0 };
  }
  const t = targets as { calories?: unknown; proteinGrams?: unknown };
  const calories =
    typeof t.calories === "number" && Number.isFinite(t.calories)
      ? t.calories
      : 0;
  const proteinGrams =
    typeof t.proteinGrams === "number" && Number.isFinite(t.proteinGrams)
      ? t.proteinGrams
      : 0;
  return { calories, proteinGrams };
}

const STRIDE_METERS = 0.762;
const KCAL_PER_STEP_FALLBACK = 0.04;

function deriveStepMetrics(steps: number, weightKg: number | null) {
  const distanceKm = Math.round(((steps * STRIDE_METERS) / 1000) * 10) / 10;
  const calories =
    weightKg != null && weightKg > 0
      ? Math.round(steps * 0.0005 * weightKg * 3.5)
      : Math.round(steps * KCAL_PER_STEP_FALLBACK);
  return { calories, distanceKm };
}

userReportRouter.get("/", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const now = new Date();
  const today = startOfDay(now);
  const tomorrow = addDays(today, 1);
  const weekStart = addDays(today, -6);
  const dateKey = localDateKey(today);

  const [
    user,
    profile,
    waterSettings,
    walkGoal,
    todayStepsRow,
    todayWaterAgg,
    todayWaterLogs,
    mealPlan,
    workoutPlan,
    subscriptions,
    progressPhotosCount,
    communityPostsCount,
    stepsWeekRows,
    waterWeekLogs,
    mealLogsToday,
    workoutLogsToday,
    mealLogsWeek,
    workoutLogsWeek,
    allTimeWorkouts,
    allTimeMeals,
    allTimeStepsAgg,
    allTimeWaterAgg,
  ] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        name: true,
        email: true,
        emailVerified: true,
        createdAt: true,
      },
    }),
    prisma.profile.findUnique({ where: { userId } }),
    prisma.waterSettings.findUnique({ where: { userId } }),
    prisma.walkGoal.findUnique({ where: { userId } }),
    prisma.walkProgress.findUnique({
      where: { userId_date: { userId, date: today } },
      select: { steps: true },
    }),
    prisma.waterLog.aggregate({
      where: { userId, loggedAt: { gte: today, lt: tomorrow } },
      _sum: { amountMl: true },
    }),
    prisma.waterLog.count({
      where: { userId, loggedAt: { gte: today, lt: tomorrow } },
    }),
    prisma.aiMealPlan.findFirst({
      where: { userId, isActive: true, status: "published" },
      orderBy: { publishedAt: "desc" },
      select: {
        id: true,
        title: true,
        weekStart: true,
        weekEnd: true,
        plan: true,
      },
    }),
    prisma.aiWorkoutPlan.findFirst({
      where: { userId, isActive: true, status: "published" },
      orderBy: { publishedAt: "desc" },
      select: {
        id: true,
        title: true,
        weekStart: true,
        weekEnd: true,
        plan: true,
      },
    }),
    prisma.mealActivePlan.findMany({
      where: { userId, endDate: { gt: now } },
      orderBy: { endDate: "desc" },
      select: {
        endDate: true,
        plan: { select: { name: true, expirationDuration: true } },
      },
    }),
    prisma.progressPhoto.count({ where: { userId } }),
    prisma.communityPost.count({ where: { userId, ...notDeleted() } }),
    prisma.walkProgress.findMany({
      where: { userId, date: { gte: weekStart, lt: tomorrow } },
      select: { date: true, steps: true },
    }),
    prisma.waterLog.findMany({
      where: { userId, loggedAt: { gte: weekStart, lt: tomorrow } },
      select: { loggedAt: true, amountMl: true },
    }),
    prisma.mealIntakeLog.findMany({
      where: { userId, planDate: today },
      select: { calories: true, proteinGrams: true },
    }),
    prisma.workoutCompletionLog.findMany({
      where: { userId, planDate: today },
      select: { caloriesBurned: true, durationMin: true },
    }),
    prisma.mealIntakeLog.findMany({
      where: { userId, planDate: { gte: weekStart, lt: tomorrow } },
      select: { planDate: true },
    }),
    prisma.workoutCompletionLog.findMany({
      where: { userId, planDate: { gte: weekStart, lt: tomorrow } },
      select: { planDate: true },
    }),
    prisma.workoutCompletionLog.count({ where: { userId } }),
    prisma.mealIntakeLog.count({ where: { userId } }),
    prisma.walkProgress.aggregate({
      where: { userId },
      _sum: { steps: true },
    }),
    prisma.waterLog.aggregate({
      where: { userId },
      _sum: { amountMl: true },
    }),
  ]);

  if (!user) {
    res.status(404).json({ error: "user_not_found" });
    return;
  }

  const weightKg = profile?.weightKg ?? null;
  const goalSteps = walkGoal?.targetSteps ?? 10_000;
  const todaySteps = todayStepsRow?.steps ?? 0;
  const stepMetrics = deriveStepMetrics(todaySteps, weightKg);
  const waterGoalMl = waterSettings?.dailyGoalMl ?? 2000;
  const todayWaterMl = todayWaterAgg._sum.amountMl ?? 0;

  const mealDayIndex =
    mealPlan != null ? dayIndexForToday(mealPlan.weekStart, mealPlan.weekEnd) : null;
  const workoutDayIndex =
    workoutPlan != null
      ? dayIndexForToday(workoutPlan.weekStart, workoutPlan.weekEnd)
      : null;

  const mealTargetsToday =
    mealPlan != null && mealDayIndex != null
      ? mealTargets(mealPlan.plan)
      : { calories: 0, proteinGrams: 0 };
  const todayMealsTotal =
    mealPlan != null && mealDayIndex != null
      ? mealCountForDay(mealPlan.plan, mealDayIndex)
      : 0;
  const todayWorkoutsTotal =
    workoutPlan != null && workoutDayIndex != null
      ? sessionCountForDay(workoutPlan.plan, workoutDayIndex)
      : 0;

  const todayCaloriesEaten = mealLogsToday.reduce((s, r) => s + r.calories, 0);
  const todayProteinEaten = mealLogsToday.reduce((s, r) => s + r.proteinGrams, 0);
  const todayCaloriesBurned = workoutLogsToday.reduce(
    (s, r) => s + r.caloriesBurned,
    0,
  );
  const todayWorkoutMin = workoutLogsToday.reduce(
    (s, r) => s + r.durationMin,
    0,
  );

  const stepsByDate = new Map<string, number>();
  for (const row of stepsWeekRows) {
    stepsByDate.set(localDateKey(row.date), row.steps);
  }

  const waterByDate = new Map<string, number>();
  for (const row of waterWeekLogs) {
    const key = localDateKey(row.loggedAt);
    waterByDate.set(key, (waterByDate.get(key) ?? 0) + row.amountMl);
  }

  const mealsByDate = new Map<string, number>();
  for (const row of mealLogsWeek) {
    const key = localDateKey(row.planDate);
    mealsByDate.set(key, (mealsByDate.get(key) ?? 0) + 1);
  }

  const workoutsByDate = new Map<string, number>();
  for (const row of workoutLogsWeek) {
    const key = localDateKey(row.planDate);
    workoutsByDate.set(key, (workoutsByDate.get(key) ?? 0) + 1);
  }

  const weekDays: Array<{
    date: string;
    steps: number;
    waterMl: number;
    mealsDone: number;
    workoutsDone: number;
  }> = [];
  let weekSteps = 0;
  let weekWaterMl = 0;
  let weekMealsDone = 0;
  let weekWorkoutsDone = 0;

  for (let i = 0; i < 7; i++) {
    const day = addDays(weekStart, i);
    const key = localDateKey(day);
    const steps = stepsByDate.get(key) ?? 0;
    const waterMl = waterByDate.get(key) ?? 0;
    const mealsDone = mealsByDate.get(key) ?? 0;
    const workoutsDone = workoutsByDate.get(key) ?? 0;
    weekDays.push({ date: key, steps, waterMl, mealsDone, workoutsDone });
    weekSteps += steps;
    weekWaterMl += waterMl;
    weekMealsDone += mealsDone;
    weekWorkoutsDone += workoutsDone;
  }

  res.json({
    generatedAt: now.toISOString(),
    account: {
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified != null,
      memberSince: user.createdAt.toISOString(),
    },
    profile: profile
      ? {
          hasProfile: true,
          goal: profile.goal,
          goals: profile.goals,
          gender: profile.gender,
          weightKg: profile.weightKg,
          targetWeightKg: profile.targetWeightKg,
          heightCm: profile.heightCm,
          diet: profile.diet,
          weightUnit: profile.weightUnit,
        }
      : { hasProfile: false },
    plans: {
      mealPlan: mealPlan
        ? {
            id: mealPlan.id,
            title: mealPlan.title,
            weekStart: mealPlan.weekStart.toISOString(),
            weekEnd: mealPlan.weekEnd.toISOString(),
            inPlanWeek: mealDayIndex != null,
            dayIndex: mealDayIndex,
          }
        : null,
      workoutPlan: workoutPlan
        ? {
            id: workoutPlan.id,
            title: workoutPlan.title,
            weekStart: workoutPlan.weekStart.toISOString(),
            weekEnd: workoutPlan.weekEnd.toISOString(),
            inPlanWeek: workoutDayIndex != null,
            dayIndex: workoutDayIndex,
          }
        : null,
      subscriptions: subscriptions.map((s) => ({
        planName: s.plan.name,
        isLifetime: s.plan.expirationDuration === "lifetime",
        endDate: s.endDate.toISOString(),
      })),
    },
    today: {
      date: dateKey,
      steps: {
        steps: todaySteps,
        goalSteps,
        ...stepMetrics,
      },
      water: {
        totalMl: todayWaterMl,
        goalMl: waterGoalMl,
        logCount: todayWaterLogs,
      },
      meals: {
        hasPlan: mealPlan != null,
        inPlanWeek: mealDayIndex != null,
        completedCount: mealLogsToday.length,
        totalMeals: todayMealsTotal,
        caloriesEaten: Math.round(todayCaloriesEaten),
        calorieTarget: Math.round(mealTargetsToday.calories),
        proteinEaten: Math.round(todayProteinEaten),
        proteinTarget: Math.round(mealTargetsToday.proteinGrams),
      },
      workouts: {
        hasPlan: workoutPlan != null,
        inPlanWeek: workoutDayIndex != null,
        completedCount: workoutLogsToday.length,
        totalSessions: todayWorkoutsTotal,
        caloriesBurned: todayCaloriesBurned,
        durationMin: todayWorkoutMin,
      },
    },
    week: {
      days: weekDays,
      totals: {
        steps: weekSteps,
        waterMl: weekWaterMl,
        mealsDone: weekMealsDone,
        workoutsDone: weekWorkoutsDone,
      },
    },
    allTime: {
      progressPhotos: progressPhotosCount,
      communityPosts: communityPostsCount,
      workoutsCompleted: allTimeWorkouts,
      mealsLogged: allTimeMeals,
      totalSteps: allTimeStepsAgg._sum.steps ?? 0,
      totalWaterMl: allTimeWaterAgg._sum.amountMl ?? 0,
    },
  });
});
