import { prisma } from "./prisma.ts";

export const AI_USAGE_SOURCES = [
  "meal_plan",
  "workout_plan",
  "fitness_chat",
  "food_scan",
] as const;

export type AiUsageSource = (typeof AI_USAGE_SOURCES)[number];

export interface TokenUsageCounts {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface RecordAiUsageInput {
  source: AiUsageSource;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  userId?: string | null;
}

export function tokensFromCompletion(
  usage: TokenUsageCounts | undefined | null,
): Pick<RecordAiUsageInput, "promptTokens" | "completionTokens" | "totalTokens"> {
  return {
    promptTokens: usage?.prompt_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
    totalTokens: usage?.total_tokens ?? 0,
  };
}

/** Best-effort persistence — never throw to callers. */
export async function recordAiTokenUsage(input: RecordAiUsageInput): Promise<void> {
  try {
    await prisma.aiTokenUsage.create({
      data: {
        source: input.source,
        model: input.model,
        promptTokens: input.promptTokens,
        completionTokens: input.completionTokens,
        totalTokens: input.totalTokens,
        userId: input.userId ?? null,
      },
    });
  } catch (err) {
    console.warn(
      "[ai-usage] failed to record usage:",
      err instanceof Error ? err.message : err,
    );
  }
}

export function recordAiTokenUsageFireAndForget(input: RecordAiUsageInput): void {
  void recordAiTokenUsage(input);
}
