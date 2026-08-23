// Weekly workout-plan generation.
//
// Ported from the admin's `server/lib/workout_plan_ai.ts` so the backend
// can build a plan on its own — the admin still generates on demand when
// an operator clicks "Generate", and onboarding now generates
// automatically (see jobs/workout_plans.ts). Both paths must produce the
// same shape because the Flutter Workouts tab reads one schema.
//
// Keep the two copies in step: a change to the JSON schema or the prompt
// here needs the same change in admin/server/lib/workout_plan_ai.ts.

import OpenAI from "openai";

import {
  recordAiTokenUsageFireAndForget,
  tokensFromCompletion,
} from "./ai_usage.ts";

// ---------------------------------------------------------------------------
// JSON schema — matches Flutter Workouts tab expectations.
// ---------------------------------------------------------------------------

const WORKOUT_PLAN_SCHEMA = {
  name: "weekly_workout_plan",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string" },
      notes: {
        type: "string",
        description:
          "1-3 sentences on how this week supports the user's fitness goal.",
      },
      targets: {
        type: "object",
        additionalProperties: false,
        properties: {
          sessionsPerWeek: { type: "integer" },
          totalMinutes: { type: "integer" },
        },
        required: ["sessionsPerWeek", "totalMinutes"],
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
            label: { type: "string" },
            isRestDay: { type: "boolean" },
            dailyTotals: {
              type: "object",
              additionalProperties: false,
              properties: {
                sessionCount: { type: "integer" },
                totalMinutes: { type: "integer" },
              },
              required: ["sessionCount", "totalMinutes"],
            },
            sessions: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  id: {
                    type: "string",
                    description: "Stable slug, e.g. full-body-push",
                  },
                  title: { type: "string" },
                  subtitle: { type: "string" },
                  type: {
                    type: "string",
                    enum: ["strength", "cardio", "mobility", "hiit", "yoga"],
                  },
                  durationMin: { type: "integer" },
                  intensity: {
                    type: "string",
                    enum: ["easy", "moderate", "hard"],
                  },
                  scheduledHour: { type: "integer" },
                  scheduledMinute: { type: "integer" },
                  exercises: {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        exerciseId: { type: "string" },
                        name: { type: "string" },
                        description: { type: "string" },
                        type: {
                          type: "string",
                          enum: [
                            "strength",
                            "cardio",
                            "mobility",
                            "hiit",
                            "yoga",
                          ],
                        },
                        workoutTime: { type: "string" },
                        videoUrl: { type: "string" },
                      },
                      required: [
                        "exerciseId",
                        "name",
                        "description",
                        "type",
                        "workoutTime",
                        "videoUrl",
                      ],
                    },
                  },
                },
                required: [
                  "id",
                  "title",
                  "subtitle",
                  "type",
                  "durationMin",
                  "intensity",
                  "scheduledHour",
                  "scheduledMinute",
                  "exercises",
                ],
              },
            },
          },
          required: [
            "dayIndex",
            "label",
            "isRestDay",
            "dailyTotals",
            "sessions",
          ],
        },
      },
    },
    required: ["title", "notes", "targets", "days"],
  },
} as const;

export interface WorkoutPlanUserContext {
  name: string;
  goal: string;
  gender: string;
  ageYears: number;
  heightCm: number;
  weightKg: number;
  targetWeightKg: number;
  diet: string;
  about?: string | null;
}

export interface CatalogExercise {
  id: string;
  name: string;
  description: string;
  type: string;
  workoutTime: string;
  videoUrl: string;
}

export interface GeneratedWorkoutPlan {
  title: string;
  notes: string;
  targets: { sessionsPerWeek: number; totalMinutes: number };
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

function buildPrompt(
  ctx: WorkoutPlanUserContext,
  exercises: CatalogExercise[],
): string {
  const aboutLine = ctx.about?.trim()
    ? `User notes: ${ctx.about.trim()}`
    : "";
  const catalog = exercises
    .map(
      (e) =>
        `- id=${e.id} | ${e.name} (${e.type}, ${e.workoutTime}) | video=${e.videoUrl} — ${e.description.slice(0, 80)}`,
    )
    .join("\n");

  return `Create a personalised 7-day workout plan for a fitness app user.

User profile:
- Name: ${ctx.name}
- Goal: ${ctx.goal}
- Gender: ${ctx.gender}
- Age: ${ctx.ageYears} years
- Height: ${ctx.heightCm.toFixed(0)} cm
- Weight: ${ctx.weightKg.toFixed(1)} kg → target ${ctx.targetWeightKg.toFixed(1)} kg
${aboutLine}

Available exercises from our catalog (MUST pick from this list only — copy exerciseId, name, type, workoutTime, videoUrl exactly):
${catalog}

Requirements:
- Exactly 7 days: dayIndex 0 = Monday … 6 = Sunday.
- Include 1-2 rest days per week (isRestDay true, sessions empty).
- Training days: 1-3 sessions per day, each with 2-6 exercises from the catalog.
- Match session type to exercise types. Vary modalities across the week.
- Realistic durations (8-45 min per session). scheduledHour 6-20.
- Stable unique session ids (kebab-case).`;
}

const SYSTEM_PROMPT = `You are an expert strength & conditioning coach building weekly workout plans for a fitness app.
Always return valid JSON matching the schema. Only use exercises from the provided catalog — never invent exerciseIds.
Include at least one rest day.`;

export async function generateWeeklyWorkoutPlan(
  ctx: WorkoutPlanUserContext,
  exercises: CatalogExercise[],
  options?: { userId?: string },
): Promise<GeneratedWorkoutPlan> {
  if (exercises.length === 0) {
    throw new Error("Exercise catalog is empty — add workouts in admin first.");
  }

  const model = "gpt-4o-mini";
  const openai = client();
  const completion = await openai.chat.completions.create({
    model,
    temperature: 0.45,
    response_format: {
      type: "json_schema",
      json_schema: WORKOUT_PLAN_SCHEMA,
    },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildPrompt(ctx, exercises) },
    ],
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) {
    throw new Error("Empty response from OpenAI");
  }

  const parsed = JSON.parse(content) as GeneratedWorkoutPlan;
  if (!Array.isArray(parsed.days) || parsed.days.length !== 7) {
    throw new Error("Model returned an invalid week (expected 7 days)");
  }

  recordAiTokenUsageFireAndForget({
    source: "workout_plan",
    model,
    ...tokensFromCompletion(completion.usage),
    userId: options?.userId,
  });

  return parsed;
}

export { weekRangeFor, ageFromDob } from "./meal_plan_ai.ts";
