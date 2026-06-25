// Progress photos API.
//
// Daily photo journal — a row per uploaded check-in. All endpoints
// are scoped to the signed-in user (no cross-account read or delete)
// and live behind `requireAuth`.
//
//   GET    /                      → paginated newest-first list
//   POST   /                      → create { photoUrl, takenAt?, note? }
//   DELETE /:id                   → delete own photo
//
// The actual image bytes are uploaded separately through
// `/uploads/images`; the client passes back the URL the upload
// service returned. We re-validate the URL shape here (defence in
// depth) so a tampered client can't store arbitrary strings in the
// gallery.
//
// Pagination uses a stable composite cursor — `takenAt` plus `id`
// as a tiebreaker — so two photos taken in the same second can't
// shadow each other across pages.

import type { Request, Response } from "express";
import { Router } from "express";

import { prisma } from "../lib/prisma.ts";
import { requireAuth } from "../middleware/require_auth.ts";

export const progressPhotosRouter: Router = Router();
progressPhotosRouter.use(requireAuth);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NOTE_MAX = 200;
const DEFAULT_PAGE = 60;
const MAX_PAGE = 120;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Allow only `/files/images/<name>` URLs (relative or absolute). Mirror
 *  of the helper in community.ts; intentionally duplicated so the two
 *  routers can evolve their URL rules independently if needed. */
function isAllowedImageUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    const path = url.startsWith("http")
      ? new URL(url).pathname
      : url.startsWith("/")
        ? url
        : `/${url}`;
    return /^\/files\/images\/[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(path);
  } catch {
    return false;
  }
}

/** Parse an ISO8601 string to a Date; rejects junk values like
 *  `"yesterday"` so we don't store NaN-stamped rows. Returns `null`
 *  when the caller didn't supply a value (and the column default
 *  will kick in). */
function parseDate(value: unknown): Date | null | undefined {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return d;
}

function shapePhoto(row: {
  id: string;
  photoUrl: string;
  note: string | null;
  takenAt: Date;
  createdAt: Date;
}) {
  return {
    id: row.id,
    photoUrl: row.photoUrl,
    note: row.note,
    takenAt: row.takenAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

// Decode a cursor of the form `<isoTakenAt>__<id>`. Anything
// malformed is treated as "no cursor" so a stale bookmark falls
// back to the latest page instead of 400-ing.
function decodeCursor(raw: unknown): { takenAt: Date; id: string } | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const sep = raw.indexOf("__");
  if (sep <= 0) return null;
  const isoPart = raw.slice(0, sep);
  const idPart = raw.slice(sep + 2);
  if (!idPart) return null;
  const d = new Date(isoPart);
  if (Number.isNaN(d.getTime())) return null;
  return { takenAt: d, id: idPart };
}

function encodeCursor(row: { takenAt: Date; id: string }): string {
  return `${row.takenAt.toISOString()}__${row.id}`;
}

// ---------------------------------------------------------------------------
// GET / — list
// ---------------------------------------------------------------------------

/** Newest-first list with cursor pagination. The default page (60) is
 *  enough to cover roughly two months of daily check-ins, which is
 *  what the gallery's 3-column grid renders before the user has to
 *  scroll-to-load. */
progressPhotosRouter.get("/", async (req: Request, res: Response) => {
  const rawLimit = Number(req.query.limit);
  const limit = Math.min(
    MAX_PAGE,
    Math.max(1, Number.isFinite(rawLimit) ? rawLimit : DEFAULT_PAGE),
  );
  const cursor = decodeCursor(req.query.cursor);

  // Composite "less than" cursor: rows older than the cursor row,
  // or same instant with a smaller id. Without the id tiebreaker
  // two photos taken in the same second would skip each other.
  const rows = await prisma.progressPhoto.findMany({
    where: {
      userId: req.userId!,
      ...(cursor && {
        OR: [
          { takenAt: { lt: cursor.takenAt } },
          { takenAt: cursor.takenAt, id: { lt: cursor.id } },
        ],
      }),
    },
    // Fetch one extra so we can compute `nextCursor` without a
    // second roundtrip. We slice it off before returning.
    take: limit + 1,
    orderBy: [{ takenAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      photoUrl: true,
      note: true,
      takenAt: true,
      createdAt: true,
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? encodeCursor(page[page.length - 1]!) : null;

  res.json({
    photos: page.map(shapePhoto),
    nextCursor,
  });
});

// ---------------------------------------------------------------------------
// POST / — create
// ---------------------------------------------------------------------------

progressPhotosRouter.post("/", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    photoUrl?: unknown;
    takenAt?: unknown;
    note?: unknown;
  };

  if (!isAllowedImageUrl(body.photoUrl)) {
    res.status(400).json({
      error: "invalid_photo_url",
      message: "photoUrl must be a /files/images/... URL",
    });
    return;
  }

  const takenAt = parseDate(body.takenAt);
  if (takenAt === undefined) {
    res.status(400).json({ error: "invalid_taken_at" });
    return;
  }

  let note: string | null = null;
  if (typeof body.note === "string") {
    const trimmed = body.note.trim();
    if (trimmed.length > NOTE_MAX) {
      res.status(400).json({ error: "invalid_note" });
      return;
    }
    note = trimmed.length === 0 ? null : trimmed;
  } else if (body.note != null) {
    res.status(400).json({ error: "invalid_note" });
    return;
  }

  const row = await prisma.progressPhoto.create({
    data: {
      userId: req.userId!,
      photoUrl: body.photoUrl,
      note,
      // `takenAt: null` means "use the default" — Prisma rejects an
      // explicit null on a defaulted-non-null column, so we just
      // omit the key in that case.
      ...(takenAt && { takenAt }),
    },
    select: {
      id: true,
      photoUrl: true,
      note: true,
      takenAt: true,
      createdAt: true,
    },
  });

  res.status(201).json({ photo: shapePhoto(row) });
});

// ---------------------------------------------------------------------------
// DELETE /:id
// ---------------------------------------------------------------------------

/** Hard delete — the row plus the user's claim on the underlying
 *  image. We DON'T currently scrub the file from disk because the
 *  same URL could theoretically be referenced elsewhere (community
 *  post, future "share to feed"). A background sweep can reclaim
 *  orphaned files later; the row going away is what matters for the
 *  gallery. */
progressPhotosRouter.delete("/:id", async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };

  // Scope by userId in the where clause so a malicious client can't
  // delete someone else's photo by guessing an id.
  const result = await prisma.progressPhoto.deleteMany({
    where: { id, userId: req.userId! },
  });

  if (result.count === 0) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  res.json({ id });
});
