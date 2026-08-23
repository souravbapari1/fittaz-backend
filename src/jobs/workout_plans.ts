// Automatic weekly workout-plan generation.
//
// Sibling of `weekly_meal_plans.ts`, and deliberately shaped the same
// way — same outcome union, same skip-if-a-plan-already-exists rule,
// same create-then-publish transaction — so the two onboarding paths
// behave identically and can be reasoned about together.
//
// Until now a workout plan only existed if an operator opened the user
// in the admin and clicked "Generate". A member who finished onboarding
// got meals automatically but an empty Workouts tab.

import { getUserAccessPayload } from "../lib/access_features.ts";
import { prisma } from "../lib/prisma.ts";
import {
  ageFromDob,
  generateWeeklyWorkoutPlan,
  weekRangeFor,
} from "../lib/workout_plan_ai.ts";
import { hydrateWorkoutPlanWithCatalog } from "../lib/workout_plan_hydrate.ts";

const profileSelect = {
  goal: true,
  gender: true,
  dob: true,
  heightCm: true,
  weightKg: true,
  targetWeightKg: true,
  diet: true,
  about: true,
} as const;

const catalogSelect = {
  id: true,
  name: true,
  description: true,
  type: true,
  workoutTime: true,
  videoUrl: true,
} as const;

/**
 * How many catalog exercises to put in front of the model. Matches the
 * admin's manual generate path — enough variety for a week without
 * blowing up the prompt.
 */
const CATALOG_LIMIT = 40;

export interface GenerateWorkoutPlanOptions {
  /** When false, generate even if the user lacks workout-plan entitlement. */
  requireAccess?: boolean;
}

export type WorkoutPlanOutcome =
  | "generated"
  | "skipped"
  | "no_access"
  | "no_profile"
  | "no_catalog";

/**
 * Generate and publish a workout plan for one user for the current
 * calendar week. Skips when the user already has a plan for that week,
 * which is what makes this safe to call more than once.
 */
export async function generateAndPublishWorkoutPlanForUser(
  userId: string,
  ref = new Date(),
  options: GenerateWorkoutPlanOptions = {},
): Promise<WorkoutPlanOutcome> {
  const requireAccess = options.requireAccess !== false;

  if (requireAccess) {
    const access = await getUserAccessPayload(userId);
    if (!access.unlockedFeatures.includes("workoutPlan")) {
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

  // Cheap guard first: don't pay OpenAI to rebuild a week the user
  // already has.
  const existing = await prisma.aiWorkoutPlan.findFirst({
    where: { userId, weekStart },
    select: { id: true },
  });
  if (existing) {
    return "skipped";
  }

  const exercises = await prisma.exercise.findMany({
    orderBy: { createdAt: "desc" },
    take: CATALOG_LIMIT,
    select: catalogSelect,
  });
  if (exercises.length === 0) {
    // A brand-new deployment with no exercises yet. Not an error worth
    // throwing — the member simply has no plan until the catalog is
    // seeded, and the caller logs it.
    return "no_catalog";
  }

  const p = user.profile;
  const generated = await generateWeeklyWorkoutPlan(
    {
      name: user.name,
      goal: p.goal,
      gender: p.gender,
      ageYears: ageFromDob(p.dob),
      heightCm: p.heightCm,
      weightKg: p.weightKg,
      targetWeightKg: p.targetWeightKg,
      diet: p.diet,
      about: p.about,
    },
    exercises,
    { userId },
  );

  // The model copies exercise fields out of the prompt and sometimes
  // paraphrases them; re-stamp from the catalog so video URLs resolve.
  const hydrated = hydrateWorkoutPlanWithCatalog(generated, exercises);

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const row = await tx.aiWorkoutPlan.create({
      data: {
        userId,
        title: hydrated.title || title,
        weekStart,
        weekEnd,
        plan: hydrated as object,
        notes: hydrated.notes,
        status: "draft",
        isActive: false,
      },
      select: { id: true },
    });

    // Archive whatever was active *before* promoting the new row, so
    // there's never a window with two active plans for one user.
    await tx.aiWorkoutPlan.updateMany({
      where: { userId, isActive: true },
      data: { isActive: false, status: "archived" },
    });

    await tx.aiWorkoutPlan.update({
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
 * Fire-and-forget workout plan generation after a user completes
 * onboarding. Does not block the HTTP response; failures are logged only.
 *
 * Access is not required here: a member who has just answered the
 * onboarding questions should see a plan whether or not they've bought
 * anything, exactly as the meal-plan path already works.
 */
export function scheduleWorkoutPlanForNewUser(userId: string): void {
  void generateAndPublishWorkoutPlanForUser(userId, new Date(), {
    requireAccess: false,
  })
    .then((outcome) => {
      if (outcome === "generated") {
        console.log(
          `[workout-plan] onboarding plan published for user ${userId}`,
        );
        return;
      }
      if (outcome === "skipped") {
        console.log(
          `[workout-plan] onboarding skipped — plan already exists for user ${userId}`,
        );
        return;
      }
      if (outcome === "no_profile") {
        console.warn(
          `[workout-plan] onboarding skipped — no profile for user ${userId}`,
        );
        return;
      }
      if (outcome === "no_catalog") {
        console.warn(
          `[workout-plan] onboarding skipped — exercise catalog is empty; ` +
            `add exercises in admin so new members get a plan`,
        );
      }
    })
    .catch((err) => {
      console.error(
        `[workout-plan] onboarding generation failed for user ${userId}:`,
        err instanceof Error ? err.message : err,
      );
    });
}
