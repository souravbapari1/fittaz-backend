import { Router } from "express";
import type { Request, Response } from "express";

import { prisma } from "../lib/prisma.ts";

export const plansRouter: Router = Router();

// Public marketplace listing.
//
// Powers the Flutter "Packages" screen. Returned without auth on
// purpose — browsing the catalog should never require a sign-in, so
// that's the same contract every consumer storefront ships.
//
// Ordering: cheapest first, with createdAt as a tiebreaker so the list
// is deterministic when two plans share a price. Once we add a
// `displayOrder` / `isFeatured` column, sort by those before price.
//
// TODO(visibility): when `Plans.isArchived` lands, add
// `where: { isArchived: false }` here so archived plans disappear from
// the storefront without being deleted.
plansRouter.get("/", async (_req: Request, res: Response) => {
  const plans = await prisma.plans.findMany({
    orderBy: [{ price: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      name: true,
      description: true,
      price: true,
      features: true,
      accessFeatures: true,
      expirationDuration: true,
      createdAt: true,
    },
  });
  res.json({ plans });
});
