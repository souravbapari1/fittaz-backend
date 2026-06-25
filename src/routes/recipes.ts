import { Router } from "express";
import type { Request, Response } from "express";

import { prisma } from "../lib/prisma.ts";

export const recipesRouter: Router = Router();

// =============================================================================
// Public recipe catalog
// =============================================================================
//
// Powers the Flutter "Recipes" screen. Like /plans, this is mounted
// without auth — browsing the recipe ebook should never require a
// sign-in (gating premium PDFs is a separate concern handled
// per-recipe URL later if needed).
//
// Ordering matches the admin's curated `displayOrder asc` then
// `createdAt desc`, so the operator's hand-tuning is the canonical
// catalog order in the app.

/**
 * GET /recipes
 *
 * Query params (all optional):
 *   - category: filter by exact category name ("Breakfast", "Vegan", …)
 *   - search:   case-insensitive contains-match on title + description
 *
 * Returns: `{ recipes: Recipe[], categories: string[] }`
 *
 * The categories list is computed in the same call so the Flutter
 * screen can build its filter chips without a second round-trip on
 * first load.
 */
recipesRouter.get("/", async (req: Request, res: Response) => {
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

  const [recipes, categoryRows] = await Promise.all([
    prisma.recipe.findMany({
      where,
      orderBy: [{ displayOrder: "asc" }, { createdAt: "desc" }],
      select: {
        id: true,
        title: true,
        description: true,
        category: true,
        coverImageUrl: true,
        pdfUrl: true,
        prepMinutes: true,
        servings: true,
        createdAt: true,
      },
    }),
    // Distinct categories across the WHOLE published catalog (not
    // filtered by the current search/category) so the chip row stays
    // stable as the user filters.
    prisma.recipe.findMany({
      where: { isPublished: true, category: { not: null } },
      select: { category: true },
      distinct: ["category"],
      orderBy: { category: "asc" },
    }),
  ]);

  const categories = categoryRows
    .map((r) => r.category)
    .filter((c): c is string => typeof c === "string" && c.length > 0);

  res.json({ recipes, categories });
});

/**
 * GET /recipes/:id
 *
 * Single recipe lookup for the detail screen. 404s with our
 * standard `{ error, message }` shape when the row is missing or
 * unpublished — same contract as the rest of the API.
 */
recipesRouter.get("/:id", async (req: Request, res: Response) => {
  const { id: rawId } = req.params as { id: string };
  const id = (rawId ?? "").trim();
  if (!id) {
    res.status(400).json({ error: "invalid_id", message: "Missing recipe id" });
    return;
  }

  const recipe = await prisma.recipe.findFirst({
    where: { id, isPublished: true },
    select: {
      id: true,
      title: true,
      description: true,
      category: true,
      coverImageUrl: true,
      pdfUrl: true,
      prepMinutes: true,
      servings: true,
      createdAt: true,
    },
  });

  if (!recipe) {
    res.status(404).json({ error: "not_found", message: "Recipe not found" });
    return;
  }

  res.json({ recipe });
});
