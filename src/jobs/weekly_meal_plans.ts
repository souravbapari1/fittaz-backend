import { getUserAccessPayload } from "../lib/access_features.ts";
import {
  ageFromDob,
  generateWeeklyMealPlan,
  weekRangeFor,
} from "../lib/meal_plan_ai.ts";
import { prisma } from "../lib/prisma.ts";

export interface WeeklyMealPlanJobResult {
  weekStart: string;
  eligible: number;
  generated: number;
  skipped: number;
  failed: number;
  errors: Array<{ userId: string; message: string }>;
}

const profileSelect = {
  goal: true,
  goals: true,
  gender: true,
  dob: true,
  heightCm: true,
  weightKg: true,
  targetWeightKg: true,
  diet: true,
  allergies: true,
  about: true,
} as const;

export interface GenerateMealPlanOptions {
  /** When false, generate even if the user lacks meal-plan entitlement. */
  requireAccess?: boolean;
}

/**
 * Generate and publish a meal plan for one user for the current calendar
 * week. Skips when the user already has a plan for that week.
 */
export async function generateAndPublishMealPlanForUser(
  userId: string,
  ref = new Date(),
  options: GenerateMealPlanOptions = {},
): Promise<"generated" | "skipped" | "no_access" | "no_profile"> {
  const requireAccess = options.requireAccess !== false;

  if (requireAccess) {
    const access = await getUserAccessPayload(userId);
    if (!access.unlockedFeatures.includes("mealPlan")) {
      return "no_access";
    }
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      profile: { select: profileSelect },
    },
  });
  if (!user?.profile) {
    return "no_profile";
  }

  const { weekStart, weekEnd, title } = weekRangeFor(ref);

  const existing = await prisma.aiMealPlan.findFirst({
    where: { userId, weekStart },
    select: { id: true },
  });
  if (existing) {
    return "skipped";
  }

  const p = user.profile;
  const generated = await generateWeeklyMealPlan(
    {
      name: user.name,
      goal: p.goal,
      goals: p.goals,
      gender: p.gender,
      ageYears: ageFromDob(p.dob),
      heightCm: p.heightCm,
      weightKg: p.weightKg,
      targetWeightKg: p.targetWeightKg,
      diet: p.diet,
      allergies: p.allergies,
      about: p.about,
    },
    { userId },
  );

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const row = await tx.aiMealPlan.create({
      data: {
        userId,
        title: generated.title || title,
        weekStart,
        weekEnd,
        plan: generated as object,
        notes: generated.notes,
        status: "draft",
        isActive: false,
      },
      select: { id: true },
    });

    await tx.aiMealPlan.updateMany({
      where: { userId, isActive: true },
      data: { isActive: false, status: "archived" },
    });

    await tx.aiMealPlan.update({
      where: { id: row.id },
      data: {
        isActive: true,
        status: "published",
        publishedAt: now,
      },
    });
  });

  return "generated";
}

/**
 * Weekly cron entry point: every eligible user with a fitness profile
 * and meal-plan access gets a fresh AI plan for the current week.
 */
export async function runWeeklyMealPlanJob(
  ref = new Date(),
): Promise<WeeklyMealPlanJobResult> {
  const { weekStart } = weekRangeFor(ref);
  const users = await prisma.user.findMany({
    where: { profile: { isNot: null } },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  const result: WeeklyMealPlanJobResult = {
    weekStart: weekStart.toISOString(),
    eligible: users.length,
    generated: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  for (const { id: userId } of users) {
    try {
      const outcome = await generateAndPublishMealPlanForUser(userId, ref);
      if (outcome === "generated") {
        result.generated += 1;
        console.log(`[meal-plan-cron] generated for user ${userId}`);
      } else if (outcome === "skipped") {
        result.skipped += 1;
      }
      // no_access / no_profile are expected for some accounts — not counted
    } catch (err) {
      result.failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ userId, message });
      console.error(`[meal-plan-cron] failed for user ${userId}:`, message);
    }

    // Gentle pacing so we don't hammer OpenAI when many users qualify.
    await sleep(500);
  }

  console.log(
    `[meal-plan-cron] done week=${weekStart.toISOString().slice(0, 10)} ` +
      `generated=${result.generated} skipped=${result.skipped} failed=${result.failed}`,
  );
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fire-and-forget meal plan generation after a user completes onboarding.
 * Does not block the HTTP response; failures are logged only.
 */
export function scheduleMealPlanForNewUser(userId: string): void {
  void generateAndPublishMealPlanForUser(userId, new Date(), {
    requireAccess: false,
  })
    .then((outcome) => {
      if (outcome === "generated") {
        console.log(`[meal-plan] onboarding plan published for user ${userId}`);
        return;
      }
      if (outcome === "skipped") {
        console.log(
          `[meal-plan] onboarding skipped — plan already exists for user ${userId}`,
        );
        return;
      }
      if (outcome === "no_profile") {
        console.warn(
          `[meal-plan] onboarding skipped — no profile for user ${userId}`,
        );
      }
    })
    .catch((err) => {
      console.error(
        `[meal-plan] onboarding generation failed for user ${userId}:`,
        err instanceof Error ? err.message : err,
      );
    });
}
