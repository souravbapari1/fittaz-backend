import { Router } from "express";
import type { Request, Response } from "express";

import { prisma } from "../lib/prisma.ts";

export const meditationsRouter: Router = Router();

// =============================================================================
// Public meditation library
// =============================================================================
//
// Powers the Flutter "Meditations" screen + audio player. The
// catalog is small enough that a single query returns everything;
// when the library grows we can add cursor pagination here using
// the same pattern as /community/posts.

/**
 * GET /meditations
 *
 * Query params (all optional):
 *   - category: filter by exact category ("Sleep", "Focus", …)
 *   - search:   case-insensitive contains-match on title + description
 *
 * Returns: `{ meditations: Meditation[], categories: string[] }`
 */
meditationsRouter.get("/", async (req: Request, res: Response) => {
  const rawCategory = typeof req.query.category === "string"
    ? req.query.category.trim()
    : "";
  const rawSearch = typeof req.query.search === "string"
    ? req.query.search.trim()
    : "";

  const where = {
    isPublished: true,
    ...(rawCategory ? { category: rawCategory } : {}),
    ...(rawSearch
      ? {
          OR: [
            { title: { contains: rawSearch, mode: "insensitive" as const } },
            { description: { contains: rawSearch, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const [meditations, categoryRows] = await Promise.all([
    prisma.meditation.findMany({
      where,
      orderBy: [{ displayOrder: "asc" }, { createdAt: "desc" }],
      select: {
        id: true,
        title: true,
        description: true,
        category: true,
        coverImageUrl: true,
        audioUrl: true,
        durationSeconds: true,
        createdAt: true,
      },
    }),
    prisma.meditation.findMany({
      where: { isPublished: true, category: { not: null } },
      select: { category: true },
      distinct: ["category"],
      orderBy: { category: "asc" },
    }),
  ]);

  const categories = categoryRows
    .map((r) => r.category)
    .filter((c): c is string => typeof c === "string" && c.length > 0);

  res.json({ meditations, categories });
});

/**
 * GET /meditations/:id
 *
 * Single meditation lookup for the player screen.
 */
meditationsRouter.get("/:id", async (req: Request, res: Response) => {
  const { id: rawId } = req.params as { id: string };
  const id = (rawId ?? "").trim();
  if (!id) {
    res.status(400).json({ error: "invalid_id", message: "Missing meditation id" });
    return;
  }

  const meditation = await prisma.meditation.findFirst({
    where: { id, isPublished: true },
    select: {
      id: true,
      title: true,
      description: true,
      category: true,
      coverImageUrl: true,
      audioUrl: true,
      durationSeconds: true,
      createdAt: true,
    },
  });

  if (!meditation) {
    res.status(404).json({ error: "not_found", message: "Meditation not found" });
    return;
  }

  res.json({ meditation });
});
