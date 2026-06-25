import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { Router } from "express";

import { prisma } from "../lib/prisma.ts";
import { requireAuth } from "../middleware/require_auth.ts";

export const notificationsRouter: Router = Router();
notificationsRouter.use(requireAuth);

const DEFAULT_PAGE = 30;
const MAX_PAGE = 100;

function shapeNotification(row: {
  id: string;
  title: string;
  body: string;
  readAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    isRead: row.readAt != null,
  };
}

// GET /notifications — paginated inbox, newest first.
notificationsRouter.get("/", async (req: Request, res: Response) => {
  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.trunc(rawLimit), 1), MAX_PAGE)
    : DEFAULT_PAGE;

  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;

  const rows = await prisma.userNotification.findMany({
    where: { userId: req.userId! },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor
      ? {
          cursor: { id: cursor },
          skip: 1,
        }
      : {}),
    select: {
      id: true,
      title: true,
      body: true,
      readAt: true,
      createdAt: true,
    },
  });

  let nextCursor: string | undefined;
  if (rows.length > limit) {
    const next = rows.pop();
    nextCursor = next?.id;
  }

  res.json({
    notifications: rows.map(shapeNotification),
    nextCursor,
  });
});

// GET /notifications/unread-count
notificationsRouter.get("/unread-count", async (req: Request, res: Response) => {
  const count = await prisma.userNotification.count({
    where: { userId: req.userId!, readAt: null },
  });
  res.json({ count });
});

// PATCH /notifications/read-all
notificationsRouter.patch("/read-all", async (req: Request, res: Response) => {
  const now = new Date();
  const result = await prisma.userNotification.updateMany({
    where: { userId: req.userId!, readAt: null },
    data: { readAt: now },
  });
  res.json({ updated: result.count });
});

// DELETE /notifications — remove every notification for the signed-in user.
notificationsRouter.delete("/", async (req: Request, res: Response) => {
  const result = await prisma.userNotification.deleteMany({
    where: { userId: req.userId! },
  });
  res.json({ deleted: result.count });
});

// PATCH /notifications/:id/read
notificationsRouter.patch("/:id/read", async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: "invalid_notification" });
    return;
  }

  const existing = await prisma.userNotification.findFirst({
    where: { id, userId: req.userId! },
    select: { id: true, readAt: true },
  });
  if (!existing) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (existing.readAt != null) {
    res.json({ ok: true });
    return;
  }

  const updated = await prisma.userNotification.update({
    where: { id },
    data: { readAt: new Date() },
    select: {
      id: true,
      title: true,
      body: true,
      readAt: true,
      createdAt: true,
    },
  });
  res.json({ notification: shapeNotification(updated) });
});

// DELETE /notifications/:id — remove a single notification.
notificationsRouter.delete("/:id", async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: "invalid_notification" });
    return;
  }

  const existing = await prisma.userNotification.findFirst({
    where: { id, userId: req.userId! },
    select: { id: true },
  });
  if (!existing) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  await prisma.userNotification.delete({ where: { id } });
  res.json({ ok: true });
});

/** Generate a short batch id for admin fan-out sends. */
export function newNotificationBatchId(): string {
  return randomBytes(12).toString("hex");
}
