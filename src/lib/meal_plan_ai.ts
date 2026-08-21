import OpenAI from "openai";

import {
  recordAiTokenUsageFireAndForget,
  tokensFromCompletion,
} from "./ai_usage.ts";

// ---------------------------------------------------------------------------
// JSON schema — mirrors what the Flutter Meals tab expects.
// ---------------------------------------------------------------------------

const NUTRITION_PROPS = {
  calories: { type: "number" },
  proteinGrams: { type: "number" },
  carbsGrams: { type: "number" },
  fatGrams: { type: "number" },
  fiberGrams: { type: "number" },
  sugarGrams: { type: "number" },
  saturatedFatGrams: { type: "number" },
  sodiumMg: { type: "number" },
} as const;

const NUTRITION_REQUIRED = [
  "calories",
  "proteinGrams",
  "carbsGrams",
  "fatGrams",
  "fiberGrams",
  "sugarGrams",
  "saturatedFatGrams",
  "sodiumMg",
] as const;

const MEAL_PLAN_SCHEMA = {
  name: "weekly_meal_plan",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string" },
      notes: {
        type: "string",
        description:
          "1-3 sentences explaining how this plan supports the user's goal.",
      },
      targets: {
        type: "object",
        additionalProperties: false,
        description: "Daily macro targets for this user.",
        properties: NUTRITION_PROPS,
        required: [...NUTRITION_REQUIRED],
      },
      days: {
        type: "array",
        description: "Exactly 7 days, Monday (dayIndex 0) through Sunday (6).",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            dayIndex: {
              type: "integer",
              description: "0 = Monday … 6 = Sunday",
            },
            label: {
              type: "string",
              description: "Human label, e.g. Monday",
            },
            dailyTotals: {
              type: "object",
              additionalProperties: false,
              properties: NUTRITION_PROPS,
              required: [...NUTRITION_REQUIRED],
            },
            meals: {
              type: "array",
              description:
                "Four meals per day: breakfast, lunch, snack, dinner.",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  slot: {
                    type: "string",
                    enum: ["breakfast", "lunch", "snack", "dinner"],
                  },
                  name: {
                    type: "string",
                    description: "Short meal title, e.g. Protein oats bowl",
                  },
                  foods: {
                    type: "array",
                    items: { type: "string" },
                  },
                  nutrition: {
                    type: "object",
                    additionalProperties: false,
                    properties: NUTRITION_PROPS,
                    required: [...NUTRITION_REQUIRED],
                  },
                  prepTips: { type: "string" },
                },
                required: ["slot", "name", "foods", "nutrition", "prepTips"],
              },
            },
          },
          required: ["dayIndex", "label", "dailyTotals", "meals"],
        },
      },
    },
    required: ["title", "notes", "targets", "days"],
  },
} as const;

export interface MealPlanUserContext {
  name: string;
  goal: string;
  /// Every goal the user picked. Falls back to `[goal]` when absent.
  goals?: string[];
  gender: string;
  ageYears: number;
  heightCm: number;
  weightKg: number;
  targetWeightKg: number;
  diet: string;
  allergies: string[];
  about?: string | null;
}

export interface GeneratedMealPlan {
  title: string;
  notes: string;
  targets: Record<string, number>;
  days: unknown[];
}

let _client: OpenAI | null = null;
function client(): OpenAI {
  if (_client) return _client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey?.trim()) {
    throw new Error("OPENAI_API_KEY is not configured");
  }
  _client = new OpenAI({ apiKey });
  return _client;
}

/// The user's goals, newest schema first. Older callers that only set the
/// scalar `goal` still produce a valid one-element list.
function goalsOf(ctx: { goal: string; goals?: string[] }): string[] {
  return ctx.goals?.length ? ctx.goals : [ctx.goal];
}

function buildPrompt(ctx: MealPlanUserContext): string {
  const allergyLine =
    ctx.allergies.length > 0
      ? `Allergies to avoid: ${ctx.allergies.join(", ")}.`
      : "No known allergies.";
  const aboutLine = ctx.about?.trim()
    ? `User notes: ${ctx.about.trim()}`
    : "";
  const goalLine = goalsOf(ctx).join(", ");

  return `Create a personalised 7-day meal plan for a fitness app user.

User profile:
- Name: ${ctx.name}
- Goals: ${goalLine}
- Gender: ${ctx.gender}
- Age: ${ctx.ageYears} years
- Height: ${ctx.heightCm.toFixed(0)} cm
- Current weight: ${ctx.weightKg.toFixed(1)} kg
- Target weight: ${ctx.targetWeightKg.toFixed(1)} kg
- Diet preference: ${ctx.diet}
- ${allergyLine}
${aboutLine}

Requirements:
- Respect the diet preference strictly (no meat for vegetarian, etc.).
- Each day must have exactly 4 meals: breakfast, lunch, snack, dinner.
- Use practical Indian-friendly foods where possible unless diet suggests otherwise.
- Daily calories should align with the user's goal (deficit for weight loss, surplus for muscle gain).
- All nutrition values are per meal / per day totals — be realistic.
- dayIndex 0 = Monday through dayIndex 6 = Sunday.
- Round nutrition to one decimal place at most.`;
}

const SYSTEM_PROMPT = `You are an expert sports nutritionist building weekly meal plans for a fitness coaching app.
Always return valid JSON matching the schema exactly. Every day must have 4 meals.
Never include allergens the user listed. Be specific with portion sizes in the foods array.`;

export async function generateWeeklyMealPlan(
  ctx: MealPlanUserContext,
  options?: { userId?: string },
): Promise<GeneratedMealPlan> {
  const model = "gpt-4o-mini";
  const openai = client();
  const completion = await openai.chat.completions.create({
    model,
    temperature: 0.4,
    response_format: {
      type: "json_schema",
      json_schema: MEAL_PLAN_SCHEMA,
    },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildPrompt(ctx) },
    ],
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) {
    throw new Error("Empty response from OpenAI");
  }

  const parsed = JSON.parse(content) as GeneratedMealPlan;
  if (!Array.isArray(parsed.days) || parsed.days.length !== 7) {
    throw new Error("Model returned an invalid week (expected 7 days)");
  }

  recordAiTokenUsageFireAndForget({
    source: "meal_plan",
    model,
    ...tokensFromCompletion(completion.usage),
    userId: options?.userId,
  });

  return parsed;
}

/** Monday 00:00:00 through Sunday 23:59:59 for the week containing [ref]. */
export function weekRangeFor(ref = new Date()): {
  weekStart: Date;
  weekEnd: Date;
  title: string;
} {
  const d = new Date(ref);
  const day = d.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diffToMonday);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);

  const fmt = new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
  });
  const title = `Week of ${fmt.format(monday)} – ${fmt.format(sunday)}`;

  return { weekStart: monday, weekEnd: sunday, title };
}

export function ageFromDob(dob: Date): number {
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - dob.getUTCMonth();
  if (
    monthDiff < 0 ||
    (monthDiff === 0 && now.getUTCDate() < dob.getUTCDate())
  ) {
    age -= 1;
  }
  return Math.max(0, age);
}
