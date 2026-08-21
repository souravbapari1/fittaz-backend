// Personalised fitness AI chat coach.
//
//   POST   /fitness-chat/message              → send a message, get reply
//   GET    /fitness-chat/conversations        → list recent threads
//   GET    /fitness-chat/conversations/:id    → messages for one thread
//   DELETE /fitness-chat/conversations/:id    → delete a thread

import type { Request, Response } from "express";
import { Router } from "express";

import {
  ageFromDob,
  generateFitnessChatReply,
  streamFitnessChatReply,
  titleFromMessage,
  type FitnessChatUserContext,
} from "../lib/fitness_chat_ai.ts";
import { prisma } from "../lib/prisma.ts";
import { requireAuth } from "../middleware/require_auth.ts";
import { isObjectId } from "../lib/object_id.ts";

export const fitnessChatRouter: Router = Router();
fitnessChatRouter.use(requireAuth);

const MAX_MESSAGE_LEN = 2000;

function calendarDate(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function dayIndexForToday(weekStart: Date, weekEnd: Date): number | null {
  const today = calendarDate(new Date());
  const start = calendarDate(weekStart);
  const end = calendarDate(weekEnd);
  if (today < start || today > end) return null;
  const diff = Math.round(
    (today.getTime() - start.getTime()) / (24 * 60 * 60 * 1000),
  );
  return diff;
}

async function loadUserContext(userId: string): Promise<FitnessChatUserContext | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      name: true,
      profile: true,
    },
  });
  if (!user?.profile) return null;

  const profile = user.profile;
  const ctx: FitnessChatUserContext = {
    name: user.name,
    goal: profile.goal,
    goals: profile.goals,
    gender: profile.gender,
    ageYears: ageFromDob(profile.dob),
    heightCm: profile.heightCm,
    weightKg: profile.weightKg,
    targetWeightKg: profile.targetWeightKg,
    diet: profile.diet,
    allergies: profile.allergies,
    about: profile.about,
  };

  const mealPlan = await prisma.aiMealPlan.findFirst({
    where: { userId, isActive: true, status: "published" },
    orderBy: { publishedAt: "desc" },
    select: { id: true, title: true, notes: true, weekStart: true, weekEnd: true, plan: true },
  });

  if (mealPlan) {
    ctx.mealPlanTitle = mealPlan.title;
    ctx.mealPlanNotes = mealPlan.notes;

    const planJson = mealPlan.plan as {
      targets?: { calories?: number };
      days?: Array<{ dayIndex?: number; meals?: unknown[] }>;
    };
    const dayIdx = dayIndexForToday(mealPlan.weekStart, mealPlan.weekEnd);
    if (dayIdx != null) {
      const day = planJson.days?.find((d) => d.dayIndex === dayIdx);
      const mealsTotal = Array.isArray(day?.meals) ? day!.meals!.length : 4;
      ctx.todayMealsTotal = mealsTotal;
      ctx.todayCalorieTarget = planJson.targets?.calories;

      const planDate = calendarDate(mealPlan.weekStart);
      planDate.setDate(planDate.getDate() + dayIdx);

      const logs = await prisma.mealIntakeLog.findMany({
        where: { userId, mealPlanId: mealPlan.id, planDate },
        select: { calories: true },
      });
      ctx.todayMealsDone = logs.length;
      ctx.todayCaloriesEaten = logs.reduce((sum, r) => sum + r.calories, 0);
    }
  }

  const startOfDay = calendarDate(new Date());
  const endOfDay = new Date(startOfDay);
  endOfDay.setDate(endOfDay.getDate() + 1);

  const waterAgg = await prisma.waterLog.aggregate({
    where: {
      userId,
      loggedAt: { gte: startOfDay, lt: endOfDay },
    },
    _sum: { amountMl: true },
  });
  ctx.todayWaterMl = waterAgg._sum.amountMl ?? 0;

  const waterSettings = await prisma.waterSettings.findUnique({
    where: { userId },
    select: { dailyGoalMl: true },
  });
  ctx.waterGoalMl = waterSettings?.dailyGoalMl ?? undefined;

  return ctx;
}

function serializeMessage(row: {
  id: string;
  role: string;
  content: string;
  createdAt: Date;
}) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
  };
}

function writeSse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

type ConversationWithMessages = {
  id: string;
  title: string;
  messages: Array<{ role: string; content: string }>;
};

async function prepareMessageRequest(
  userId: string,
  body: { message?: unknown; conversationId?: unknown },
): Promise<
  | { ok: false; status: number; error: string; message?: string }
  | {
      ok: true;
      message: string;
      ctx: FitnessChatUserContext;
      conversation: ConversationWithMessages;
      history: Array<{ role: "user" | "assistant"; content: string }>;
      isNewConversation: boolean;
    }
> {
  const message =
    typeof body.message === "string" ? body.message.trim() : "";
  if (message.length === 0) {
    return {
      ok: false,
      status: 400,
      error: "empty_message",
      message: "Message is required.",
    };
  }
  if (message.length > MAX_MESSAGE_LEN) {
    return {
      ok: false,
      status: 400,
      error: "message_too_long",
      message: `Keep messages under ${MAX_MESSAGE_LEN} characters.`,
    };
  }

  const conversationId =
    typeof body.conversationId === "string" && body.conversationId.length > 0
      ? body.conversationId
      : null;

  const ctx = await loadUserContext(userId);
  if (!ctx) {
    return {
      ok: false,
      status: 400,
      error: "profile_required",
      message: "Complete your fitness profile before using the coach.",
    };
  }

  let conversation = conversationId
    ? await prisma.fitnessChatConversation.findFirst({
        where: { id: conversationId, userId },
        include: {
          messages: { orderBy: { createdAt: "asc" }, take: 30 },
        },
      })
    : null;

  if (conversationId && !conversation) {
    return { ok: false, status: 404, error: "conversation_not_found" };
  }

  const isNewConversation = !conversation;
  if (!conversation) {
    conversation = await prisma.fitnessChatConversation.create({
      data: {
        userId,
        title: titleFromMessage(message),
      },
      include: { messages: true },
    });
  }

  const history = conversation.messages.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  return {
    ok: true,
    message,
    ctx,
    conversation: {
      id: conversation.id,
      title: conversation.title,
      messages: conversation.messages,
    },
    history,
    isNewConversation,
  };
}

// POST /fitness-chat/message/stream — SSE token stream
fitnessChatRouter.post("/message/stream", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const prepared = await prepareMessageRequest(userId, req.body);
  if (!prepared.ok) {
    res.status(prepared.status).json({
      error: prepared.error,
      ...(prepared.message ? { message: prepared.message } : {}),
    });
    return;
  }

  const { message, ctx, conversation, history, isNewConversation } = prepared;

  const userRow = await prisma.fitnessChatMessage.create({
    data: {
      conversationId: conversation.id,
      role: "user",
      content: message,
    },
  });

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  writeSse(res, "meta", {
    conversationId: conversation.id,
    title: conversation.title,
    userMessage: serializeMessage(userRow),
  });

  let reply = "";
  try {
    for await (const delta of streamFitnessChatReply(ctx, history, message, {
      userId: req.userId!,
    })) {
      reply += delta;
      writeSse(res, "delta", { content: delta });
    }
  } catch (err) {
    console.error("[fitness-chat] OpenAI stream failed:", err);
    writeSse(res, "error", {
      error: "ai_unavailable",
      message: "The fitness coach is temporarily unavailable. Try again shortly.",
    });
    res.end();
    return;
  }

  const assistantRow = await prisma.fitnessChatMessage.create({
    data: {
      conversationId: conversation.id,
      role: "assistant",
      content: reply.trim(),
    },
  });

  const updatedTitle =
    isNewConversation || history.length === 0
      ? titleFromMessage(message)
      : conversation.title;

  if (updatedTitle !== conversation.title) {
    await prisma.fitnessChatConversation.update({
      where: { id: conversation.id },
      data: { title: updatedTitle, updatedAt: new Date() },
    });
  } else {
    await prisma.fitnessChatConversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() },
    });
  }

  writeSse(res, "done", {
    conversationId: conversation.id,
    title: updatedTitle,
    assistantMessage: serializeMessage(assistantRow),
  });
  res.end();
});

// POST /fitness-chat/message
fitnessChatRouter.post("/message", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const prepared = await prepareMessageRequest(userId, req.body);
  if (!prepared.ok) {
    res.status(prepared.status).json({
      error: prepared.error,
      ...(prepared.message ? { message: prepared.message } : {}),
    });
    return;
  }

  const { message, ctx, conversation, history } = prepared;

  let reply: string;
  try {
    reply = await generateFitnessChatReply(ctx, history, message, { userId });
  } catch (err) {
    console.error("[fitness-chat] OpenAI call failed:", err);
    res.status(503).json({
      error: "ai_unavailable",
      message: "The fitness coach is temporarily unavailable. Try again shortly.",
    });
    return;
  }

  const txResult = await prisma.$transaction([
    prisma.fitnessChatMessage.create({
      data: {
        conversationId: conversation.id,
        role: "user",
        content: message,
      },
    }),
    prisma.fitnessChatMessage.create({
      data: {
        conversationId: conversation.id,
        role: "assistant",
        content: reply,
      },
    }),
    prisma.fitnessChatConversation.update({
      where: { id: conversation.id },
      data: {
        updatedAt: new Date(),
        ...(history.length === 0 ? { title: titleFromMessage(message) } : {}),
      },
    }),
  ]);
  const userRow = txResult[0];
  const assistantRow = txResult[1];

  res.json({
    conversationId: conversation.id,
    title: conversation.title,
    userMessage: serializeMessage(userRow),
    assistantMessage: serializeMessage(assistantRow),
  });
});

// GET /fitness-chat/conversations
fitnessChatRouter.get("/conversations", async (req: Request, res: Response) => {
  const userId = req.userId!;
  const rows = await prisma.fitnessChatConversation.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    take: 30,
    select: {
      id: true,
      title: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { messages: true } },
    },
  });

  res.json({
    conversations: rows.map((r) => ({
      id: r.id,
      title: r.title,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      messageCount: r._count.messages,
    })),
  });
});

// GET /fitness-chat/conversations/:id
fitnessChatRouter.get(
  "/conversations/:id",
  async (req: Request, res: Response) => {
    const userId = req.userId!;
    const id = req.params.id;
    if (!isObjectId(id)) {
      res.status(404).json({ error: "conversation_not_found" });
      return;
    }

    const row = await prisma.fitnessChatConversation.findFirst({
      where: { id, userId },
      include: {
        messages: { orderBy: { createdAt: "asc" } },
      },
    });

    if (!row) {
      res.status(404).json({ error: "conversation_not_found" });
      return;
    }

    res.json({
      conversation: {
        id: row.id,
        title: row.title,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        messages: row.messages.map(serializeMessage),
      },
    });
  },
);

// DELETE /fitness-chat/conversations/:id
fitnessChatRouter.delete(
  "/conversations/:id",
  async (req: Request, res: Response) => {
    const userId = req.userId!;
    const id = req.params.id;
    if (!isObjectId(id)) {
      res.status(404).json({ error: "conversation_not_found" });
      return;
    }

    const row = await prisma.fitnessChatConversation.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!row) {
      res.status(404).json({ error: "conversation_not_found" });
      return;
    }

    await prisma.fitnessChatConversation.delete({ where: { id } });
    res.json({ ok: true });
  },
);
