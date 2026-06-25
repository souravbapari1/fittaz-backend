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
