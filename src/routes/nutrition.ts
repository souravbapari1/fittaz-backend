import { Router } from "express";
import type { Request, Response } from "express";

import { prisma } from "../lib/prisma.ts";

export const nutritionRouter: Router = Router();

// =============================================================================
// Public nutrition course
// =============================================================================
//
// Powers the Flutter "Nutrition course" screen. Lessons are grouped
// by `module` in the UI; the API just returns them in display order
// so the client can `groupBy` on the field without needing a second
// shape.

/**
 * GET /nutrition/lessons
 *
 * Query params (all optional):
 *   - module: filter by exact module label
 *   - search: case-insensitive contains-match on title + description
 *
 * Returns: `{ lessons: NutritionLesson[], modules: string[] }`
 */
nutritionRouter.get("/lessons", async (req: Request, res: Response) => {
  const rawModule = typeof req.query.module === "string"
    ? req.query.module.trim()
    : "";
  const rawSearch = typeof req.query.search === "string"
    ? req.query.search.trim()
    : "";

  const where = {
    isPublished: true,
    ...(rawModule ? { module: rawModule } : {}),
    ...(rawSearch
      ? {
          OR: [
            { title: { contains: rawSearch, mode: "insensitive" as const } },
            { description: { contains: rawSearch, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const [lessons, moduleRows] = await Promise.all([
    prisma.nutritionLesson.findMany({
      where,
      orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        title: true,
        description: true,
        module: true,
        coverImageUrl: true,
        videoUrl: true,
        pdfUrl: true,
        durationMinutes: true,
        displayOrder: true,
        createdAt: true,
      },
    }),
    prisma.nutritionLesson.findMany({
      where: { isPublished: true, module: { not: null } },
      select: { module: true },
      distinct: ["module"],
      orderBy: { module: "asc" },
    }),
  ]);

  const modules = moduleRows
    .map((r) => r.module)
    .filter((m): m is string => typeof m === "string" && m.length > 0);

  res.json({ lessons, modules });
});

/**
 * GET /nutrition/lessons/:id
 *
 * Single lesson lookup for the detail/player screen.
 */
nutritionRouter.get("/lessons/:id", async (req: Request, res: Response) => {
  const { id: rawId } = req.params as { id: string };
  const id = (rawId ?? "").trim();
  if (!id) {
    res.status(400).json({ error: "invalid_id", message: "Missing lesson id" });
    return;
  }

  const lesson = await prisma.nutritionLesson.findFirst({
    where: { id, isPublished: true },
    select: {
      id: true,
      title: true,
      description: true,
      module: true,
      coverImageUrl: true,
      videoUrl: true,
      pdfUrl: true,
      durationMinutes: true,
      displayOrder: true,
      createdAt: true,
    },
  });

  if (!lesson) {
    res.status(404).json({ error: "not_found", message: "Lesson not found" });
    return;
  }

  res.json({ lesson });
});
