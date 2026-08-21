import OpenAI from "openai";

import {
  recordAiTokenUsageFireAndForget,
  tokensFromCompletion,
} from "./ai_usage.ts";

// ---------------------------------------------------------------------------
// OpenAI client (lazy — missing key surfaces at call time, not boot)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// User context injected into every conversation's system prompt
// ---------------------------------------------------------------------------

export interface FitnessChatUserContext {
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
  mealPlanTitle?: string | null;
  mealPlanNotes?: string | null;
  todayMealsDone?: number;
  todayMealsTotal?: number;
  todayCaloriesEaten?: number;
  todayCalorieTarget?: number;
  todayWaterMl?: number;
  waterGoalMl?: number;
}

/// The user's goals, newest schema first. Older callers that only set the
/// scalar `goal` still produce a valid one-element list.
function goalsOf(ctx: { goal: string; goals?: string[] }): string[] {
  return ctx.goals?.length ? ctx.goals : [ctx.goal];
}

function buildSystemPrompt(ctx: FitnessChatUserContext): string {
  const goalLine = goalsOf(ctx).join(", ");
  const allergyLine =
    ctx.allergies.length > 0
      ? `Allergies: ${ctx.allergies.join(", ")}. Never suggest foods containing these.`
      : "No known allergies.";

  const aboutLine = ctx.about?.trim()
    ? `Personal notes: ${ctx.about.trim()}`
    : "";

  const mealPlanLine =
    ctx.mealPlanTitle != null
      ? `Active meal plan: "${ctx.mealPlanTitle}".${ctx.mealPlanNotes ? ` Notes: ${ctx.mealPlanNotes}` : ""}`
      : "No active meal plan assigned yet.";

  const intakeLine =
    ctx.todayMealsTotal != null && ctx.todayMealsTotal > 0
      ? `Today's meals: ${ctx.todayMealsDone ?? 0}/${ctx.todayMealsTotal} logged, ~${Math.round(ctx.todayCaloriesEaten ?? 0)} kcal eaten${ctx.todayCalorieTarget ? ` (target ~${Math.round(ctx.todayCalorieTarget)} kcal)` : ""}.`
      : "";

  const waterLine =
    ctx.todayWaterMl != null
      ? `Water today: ${ctx.todayWaterMl} ml${ctx.waterGoalMl ? ` (goal ${ctx.waterGoalMl} ml)` : ""}.`
      : "";

  return `You are Fittaz Coach — a warm, knowledgeable personal fitness and nutrition guide inside the Fittaz app.

Your role:
- Give practical, evidence-based advice on workouts, nutrition, recovery, habits, and mindset.
- Personalise every answer using the user's profile and today's progress below.
- Be concise: 2–4 short paragraphs or a tight bullet list. Use markdown sparingly (bold for key numbers, bullets for steps).
- Use metric units (kg, cm, kcal) unless the user asks otherwise.
- For medical conditions, injuries, or eating disorders, encourage seeing a doctor or licensed professional — you are a coach, not a clinician.
- Never invent app features that don't exist. The app has: meal plans, food scanner, water tracker, workouts, recipes, meditation, progress photos, community.

User profile:
- Name: ${ctx.name}
- Goals: ${goalLine}
- Gender: ${ctx.gender}
- Age: ${ctx.ageYears} years
- Height: ${ctx.heightCm.toFixed(0)} cm
- Weight: ${ctx.weightKg.toFixed(1)} kg → target ${ctx.targetWeightKg.toFixed(1)} kg
- Diet: ${ctx.diet}
- ${allergyLine}
${aboutLine}

${mealPlanLine}
${intakeLine}
${waterLine}`.trim();
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

const MAX_CONTEXT_MESSAGES = 20;

export async function generateFitnessChatReply(
  ctx: FitnessChatUserContext,
  history: ChatTurn[],
  userMessage: string,
  options?: { userId?: string },
): Promise<string> {
  let full = "";
  for await (const delta of streamFitnessChatReply(ctx, history, userMessage, options)) {
    full += delta;
  }
  const trimmed = full.trim();
  if (!trimmed) {
    throw new Error("Empty response from OpenAI");
  }
  return trimmed;
}

/** Yields incremental text deltas from OpenAI (streaming). */
export async function* streamFitnessChatReply(
  ctx: FitnessChatUserContext,
  history: ChatTurn[],
  userMessage: string,
  options?: { userId?: string },
): AsyncGenerator<string, void, undefined> {
  const model = "gpt-4o-mini";
  const openai = client();

  const recent = history.slice(-MAX_CONTEXT_MESSAGES);
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt(ctx) },
    ...recent.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
    { role: "user", content: userMessage },
  ];

  const stream = await openai.chat.completions.create({
    model,
    temperature: 0.65,
    max_tokens: 900,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  });

  let full = "";
  let lastUsage:
    | { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
    | undefined;
  for await (const chunk of stream) {
    if (chunk.usage) {
      lastUsage = chunk.usage;
    }
    const delta = chunk.choices[0]?.delta?.content ?? "";
    if (delta.length > 0) {
      full += delta;
      yield delta;
    }
  }

  if (!full.trim()) {
    throw new Error("Empty response from OpenAI");
  }

  if (lastUsage) {
    recordAiTokenUsageFireAndForget({
      source: "fitness_chat",
      model,
      ...tokensFromCompletion(lastUsage),
      userId: options?.userId,
    });
  }
}

/** Short title from the user's first message. */
export function titleFromMessage(message: string): string {
  const cleaned = message.replace(/\s+/g, " ").trim();
  if (cleaned.length <= 48) return cleaned || "Fitness chat";
  return `${cleaned.substring(0, 45)}…`;
}

export function ageFromDob(dob: Date): number {
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const monthDiff = today.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
    age -= 1;
  }
  return Math.max(age, 0);
}
