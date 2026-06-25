import { prisma } from "./prisma.ts";

export const ACCESS_FEATURES = [
  "mealPlan",
  "workoutPlan",
  "meditationPlan",
  "nutritionPlan",
  "community",
  "aiChat",
  "nutritionCourse",
  "progressPhotos",
  "meditationVideos",
  "recipeEbook",
  "foodScan",
] as const;

export type AccessFeature = (typeof ACCESS_FEATURES)[number];

export interface AccessPayload {
  freeAccessFeatures: AccessFeature[];
  planAccessFeatures: AccessFeature[];
  unlockedFeatures: AccessFeature[];
  hasPaidAccess: boolean;
}

const APP_SETTINGS_KEY = "app";

/** Legacy enum values that should grant the same access as a current flag. */
const FEATURE_ALIASES: Record<string, AccessFeature> = {
  workoutVideos: "workoutPlan",
};

function normalizeFeature(value: string): AccessFeature | null {
  if (ACCESS_FEATURES.includes(value as AccessFeature)) {
    return value as AccessFeature;
  }
  return FEATURE_ALIASES[value] ?? null;
}

function dedupe(values: string[]): AccessFeature[] {
  const normalized = values
    .map(normalizeFeature)
    .filter((value): value is AccessFeature => value != null);
  return Array.from(new Set(normalized));
}

async function loadFreeAccessFeatures(): Promise<AccessFeature[]> {
  try {
    const settings = await prisma.appSettings.upsert({
      where: { key: APP_SETTINGS_KEY },
      update: {},
      create: { key: APP_SETTINGS_KEY },
      select: { freeAccessFeatures: true },
    });
    return dedupe(settings.freeAccessFeatures);
  } catch (err) {
    // The AppSettings migration may not be applied yet. Fall back to
    // an empty free tier so login and /me keep working.
    const code =
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code: unknown }).code;
    if (code === "P2021") {
      console.warn(
        "[access] AppSettings table missing — run the latest migration. " +
          "Free-user features will be empty until then.",
      );
      return [];
    }
    throw err;
  }
}

export async function getFreeAccessFeatures(): Promise<AccessFeature[]> {
  return loadFreeAccessFeatures();
}

export async function getUserAccessPayload(userId: string): Promise<AccessPayload> {
  const now = new Date();
  const [freeAccessFeatures, activePlans] = await Promise.all([
    loadFreeAccessFeatures(),
    prisma.mealActivePlan.findMany({
      where: {
        userId,
        endDate: { gt: now },
      },
      select: {
        plan: {
          select: {
            accessFeatures: true,
          },
        },
      },
    }),
  ]);

  const planAccessFeatures = dedupe(
    activePlans.flatMap((row) => row.plan.accessFeatures),
  );
  const unlockedFeatures = dedupe([
    ...freeAccessFeatures,
    ...planAccessFeatures,
  ]);

  return {
    freeAccessFeatures,
    planAccessFeatures,
    unlockedFeatures,
    hasPaidAccess: planAccessFeatures.length > 0,
  };
}
