import type {
  CatalogExercise,
  GeneratedWorkoutPlan,
} from "./workout_plan_ai.ts";
import { prisma } from "./prisma.ts";

type PlanExercise = {
  exerciseId?: string;
  name?: string;
  description?: string;
  type?: string;
  workoutTime?: string;
  videoUrl?: string;
};

type PlanSession = { exercises?: PlanExercise[] };
type PlanDay = { sessions?: PlanSession[] };
type StoredPlan = { days?: PlanDay[] };

function collectExerciseIds(plan: StoredPlan): string[] {
  const ids = new Set<string>();
  for (const day of plan.days ?? []) {
    for (const session of day.sessions ?? []) {
      for (const ex of session.exercises ?? []) {
        if (ex.exerciseId) ids.add(ex.exerciseId);
      }
    }
  }
  return [...ids];
}

/** Ensure exercise video URLs come from the catalog, not stale AI output. */
export async function hydrateWorkoutPlan(plan: unknown): Promise<unknown> {
  if (!plan || typeof plan !== "object") return plan;

  const stored = plan as StoredPlan;
  const ids = collectExerciseIds(stored);
  if (ids.length === 0) return plan;

  const rows = await prisma.exercise.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      name: true,
      description: true,
      type: true,
      workoutTime: true,
      videoUrl: true,
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));

  for (const day of stored.days ?? []) {
    for (const session of day.sessions ?? []) {
      for (const ex of session.exercises ?? []) {
        const row = ex.exerciseId ? byId.get(ex.exerciseId) : undefined;
        if (!row) continue;
        ex.name = row.name;
        ex.description = row.description;
        ex.type = row.type;
        ex.workoutTime = row.workoutTime;
        ex.videoUrl = row.videoUrl;
      }
    }
  }

  return stored;
}

/**
 * Copy catalog fields (especially `videoUrl`) onto AI-picked exercises.
 *
 * Same job as [hydrateWorkoutPlan], but for the moment right after
 * generation when the catalog rows are already in hand — no second trip
 * to the database. The model is told to copy these fields verbatim from
 * the prompt, but it paraphrases descriptions and occasionally mangles a
 * URL, so the catalog always wins.
 */
export function hydrateWorkoutPlanWithCatalog(
  plan: GeneratedWorkoutPlan,
  catalog: CatalogExercise[],
): GeneratedWorkoutPlan {
  const byId = new Map(catalog.map((e) => [e.id, e]));
  const days = plan.days as PlanDay[];

  for (const day of days) {
    for (const session of day.sessions ?? []) {
      for (const ex of session.exercises ?? []) {
        const row = ex.exerciseId ? byId.get(ex.exerciseId) : undefined;
        if (!row) continue;
        ex.name = row.name;
        ex.description = row.description;
        ex.type = row.type;
        ex.workoutTime = row.workoutTime;
        ex.videoUrl = row.videoUrl;
      }
    }
  }

  return plan;
}
