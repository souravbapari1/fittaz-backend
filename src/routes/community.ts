// Community feed API.
//
// All endpoints below sit behind requireAuth — the community is for
// signed-in members only. The mounted base URL is `/community`.
//
//   GET    /posts                 → paginated feed (cursor-based)
//   POST   /posts                 → create a post { content, imageUrls? }
//   GET    /posts/:id             → single post + first page of comments
//   DELETE /posts/:id             → soft-delete own post
//   POST   /posts/:id/like        → toggle like
//   GET    /posts/:id/comments    → paginated comments
//   POST   /posts/:id/comments    → add a comment { text }
//   DELETE /comments/:id          → soft-delete own comment
//   POST   /posts/:id/report      → report a post { reason, notes? }
//   POST   /comments/:id/report   → report a comment { reason, notes? }
//
// Posts and comments use soft-delete (`deletedAt`) so the admin can
// audit moderation actions and so likes/comments under a removed post
// stay rooted in real rows rather than dangling on a 404.
//
// Images are uploaded separately through `/uploads/images`; the client
// passes back the returned public URLs in the `imageUrls` array. We
// validate the URLs only loosely (`/files/images/…`) — strict URL
// rewriting would block local dev where the public base differs from
// the API base.

import type { Request, Response } from "express";
import { Router } from "express";
import { Prisma } from "../../generated/prisma/index.js";
import { prisma } from "../lib/prisma.ts";
import { requireAuth } from "../middleware/require_auth.ts";
import { notDeleted } from "../lib/mongo_filters.ts";
import { isObjectId } from "../lib/object_id.ts";

export const communityRouter: Router = Router();

communityRouter.use(requireAuth);

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const CONTENT_MAX = 4_000;
const COMMENT_MAX = 2_000;
const MAX_IMAGES = 4;
const REPORT_REASON_MAX = 80;
const REPORT_NOTES_MAX = 1_000;

// We could lift this to env later; 20 keeps the feed snappy on phones
// while leaving headroom for short bursts of activity.
const DEFAULT_PAGE = 20;
const MAX_PAGE = 50;

// Single source of truth for which post columns we surface — keeps
// the feed query and the detail query in sync, so the Flutter client
// can deserialize both with the same DTO.
//
// `profile.goal` is pulled in so the feed can render a member's
// fitness focus (e.g. "Lose weight") under their name without an
// extra round trip. Authors without a profile (mid-onboarding)
// surface as `goal: null` and the client just hides the row.
const postBaseSelect = {
  id: true,
  content: true,
  images: true,
  createdAt: true,
  updatedAt: true,
  user: {
    select: {
      id: true,
      name: true,
      email: true,
      profile: { select: { goal: true } },
    },
  },
  _count: {
    select: {
      // Must carry the same soft-delete filter as the comments list
      // itself — an unfiltered count makes the feed advertise "3
      // comments" on a post that opens to show only one.
      comments: { where: notDeleted() },
      likes: true,
    },
  },
} satisfies Prisma.CommunityPostSelect;

const commentBaseSelect = {
  id: true,
  text: true,
  createdAt: true,
  user: {
    select: {
      id: true,
      name: true,
      email: true,
      profile: { select: { goal: true } },
    },
  },
} satisfies Prisma.CommunityCommentSelect;

/** Parse and clamp the `limit` query param. */
function parseLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE;
  return Math.min(Math.floor(n), MAX_PAGE);
}

/** Trim, then reject if the result blows past [max]. */
function safeString(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (t.length === 0 || t.length > max) return null;
  return t;
}

/**
 * Normalise an uploaded image URL to the canonical site-relative form
 * `/files/images/<name>`, or return null if it doesn't reference a valid
 * image asset.
 *
 * Accepts absolute URLs (`https://host/files/images/x.jpg`), paths that
 * carry a proxy mount prefix (`/backend-api/files/images/x.jpg` — the
 * app talks to the backend through the admin's `/backend-api` proxy),
 * and already-relative paths. We always store the relative form so
 * records stay portable across hosts and proxy prefixes; the client
 * resolves it against its configured API base at render time.
 */
function normalizeImageUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  let path: string;
  try {
    path = url.startsWith("http")
      ? new URL(url).pathname
      : url.startsWith("/")
        ? url
        : `/${url}`;
  } catch {
    return null;
  }
  // Match `/files/images/<name>` anywhere at the end of the path so an
  // optional proxy prefix (e.g. `/backend-api`) is tolerated.
  const match = /\/files\/images\/([A-Za-z0-9_-]+\.[A-Za-z0-9]+)$/.exec(path);
  return match ? `/files/images/${match[1]}` : null;
}

/**
 * Turn a Prisma post row into the wire shape the client expects.
 *
 * `likedByMe` is computed separately (the feed query attaches a
 * boolean per row) so this helper just shape-shifts and renames.
 */
interface RawAuthor {
  id: string;
  name: string;
  email: string;
  profile: { goal: string } | null;
}

interface RawPost {
  id: string;
  content: string;
  images: string[];
  createdAt: Date;
  updatedAt: Date;
  user: RawAuthor;
  _count: { comments: number; likes: number };
}

function shapeAuthor(user: RawAuthor) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    goal: user.profile?.goal ?? null,
  };
}

function shapePost(row: RawPost, likedByMe: boolean) {
  return {
    id: row.id,
    content: row.content,
    images: row.images,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    author: shapeAuthor(row.user),
    commentsCount: row._count.comments,
    likesCount: row._count.likes,
    likedByMe,
  };
}

function shapeComment(row: {
  id: string;
  text: string;
  createdAt: Date;
  user: RawAuthor;
}) {
  return {
    id: row.id,
    text: row.text,
    createdAt: row.createdAt.toISOString(),
    author: shapeAuthor(row.user),
  };
}

// ---------------------------------------------------------------------------
// Posts feed
// ---------------------------------------------------------------------------

// GET /community/posts?limit=&cursor=
//
// Cursor-based pagination keyed on post `id` (cuid, lexicographically
// sortable but we use `createdAt desc` as the primary ordering and id
// as the tiebreaker). The client passes the last post's id back as
// `cursor`; we skip 1 to consume it.
communityRouter.get("/posts", async (req: Request, res: Response) => {
  const limit = parseLimit(req.query.limit);
  const rawCursor = req.query.cursor;
  // A stale or hand-edited cursor would otherwise reach Prisma as a
  // malformed ObjectID and 500 the entire feed. Fall back to page one.
  const cursor = isObjectId(rawCursor) ? rawCursor : undefined;

  // limit+1 so we can tell whether there's a next page without an
  // extra count() query.
  const rows = await prisma.communityPost.findMany({
    where: notDeleted(),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    cursor: cursor ? { id: cursor } : undefined,
    skip: cursor ? 1 : 0,
    select: postBaseSelect,
  });

  let nextCursor: string | undefined;
  if (rows.length > limit) {
    const next = rows.pop();
    nextCursor = next?.id;
  }

  // One LIKE lookup for all visible posts in a single round trip.
  // Empty array short-circuits when the feed is empty.
  const likedIds =
    rows.length === 0
      ? new Set<string>()
      : new Set(
          (
            await prisma.communityLike.findMany({
              where: {
                userId: req.userId!,
                postId: { in: rows.map((r) => r.id) },
              },
              select: { postId: true },
            })
          ).map((r) => r.postId),
        );

  res.json({
    posts: rows.map((r) => shapePost(r, likedIds.has(r.id))),
    nextCursor,
  });
});

// POST /community/posts
// Body: { content: string, imageUrls?: string[] }
communityRouter.post("/posts", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { content?: unknown; imageUrls?: unknown };

  const content = safeString(body.content, CONTENT_MAX);
  // Empty content is allowed when there's at least one image — that
  // matches Instagram-style image posts. We re-check below.
  const contentForCheck = typeof body.content === "string" ? body.content.trim() : "";

  let images: string[] = [];
  if (Array.isArray(body.imageUrls)) {
    images = body.imageUrls
      .map(normalizeImageUrl)
      .filter((u): u is string => u !== null)
      .slice(0, MAX_IMAGES);
  }

  const hasContent = contentForCheck.length > 0;
  const hasImages = images.length > 0;
  if (!hasContent && !hasImages) {
    res.status(400).json({ error: "empty_post" });
    return;
  }
  if (hasContent && content === null) {
    res.status(400).json({ error: "invalid_content" });
    return;
  }

  const created = await prisma.communityPost.create({
    data: {
      content: content ?? "",
      images,
      userId: req.userId!,
    },
    select: postBaseSelect,
  });

  res.status(201).json({ post: shapePost(created, false) });
});

// GET /community/posts/:id
//
// Returns the post plus the first page of comments. A direct deep
// link should never require two round trips before something is
// rendered.
communityRouter.get("/posts/:id", async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  if (!isObjectId(id)) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const post = await prisma.communityPost.findFirst({
    where: { id, ...notDeleted() },
    select: postBaseSelect,
  });
  if (!post) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const [liked, comments] = await Promise.all([
    prisma.communityLike.findUnique({
      where: { userId_postId: { userId: req.userId!, postId: id } },
      select: { id: true },
    }),
    prisma.communityComment.findMany({
      where: { postId: id, ...notDeleted() },
      orderBy: { createdAt: "asc" },
      take: DEFAULT_PAGE,
      select: commentBaseSelect,
    }),
  ]);

  res.json({
    post: shapePost(post, liked !== null),
    comments: comments.map(shapeComment),
  });
});

// DELETE /community/posts/:id
//
// Soft delete. Only the author may delete their own post; an admin
// path is intentionally out of scope here (the admin panel has its
// own bypass via tRPC). Returns 204 even if it was already deleted —
// idempotent from the client's perspective.
communityRouter.delete("/posts/:id", async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  if (!isObjectId(id)) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const post = await prisma.communityPost.findUnique({
    where: { id },
    select: { userId: true, deletedAt: true },
  });
  if (!post) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (post.userId !== req.userId) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  if (post.deletedAt) {
    res.status(204).end();
    return;
  }

  await prisma.communityPost.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Likes
// ---------------------------------------------------------------------------

// POST /community/posts/:id/like
//
// Toggle: if the (userId, postId) row exists we delete it, else we
// create it. Returns the new state and the post's like count so the
// client doesn't have to refetch the feed for one number.
communityRouter.post("/posts/:id/like", async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  if (!isObjectId(id)) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const post = await prisma.communityPost.findFirst({
    where: { id, ...notDeleted() },
    select: { id: true },
  });
  if (!post) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const existing = await prisma.communityLike.findUnique({
    where: { userId_postId: { userId: req.userId!, postId: id } },
    select: { id: true },
  });

  if (existing) {
    await prisma.communityLike.delete({ where: { id: existing.id } });
  } else {
    // Catch the race where two concurrent likes from the same user
    // collide on the composite unique key. P2002 = unique constraint
    // violation; just treat it as success.
    try {
      await prisma.communityLike.create({
        data: { userId: req.userId!, postId: id },
      });
    } catch (err) {
      if (
        !(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")
      ) {
        throw err;
      }
    }
  }

  const likesCount = await prisma.communityLike.count({ where: { postId: id } });
  res.json({ liked: !existing, likesCount });
});

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

// GET /community/posts/:id/comments?cursor=&limit=
communityRouter.get("/posts/:id/comments", async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  if (!isObjectId(id)) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const limit = parseLimit(req.query.limit);
  const rawCursor = req.query.cursor;
  // A stale or hand-edited cursor would otherwise reach Prisma as a
  // malformed ObjectID and 500 the entire feed. Fall back to page one.
  const cursor = isObjectId(rawCursor) ? rawCursor : undefined;

  // Don't require the post to exist before listing — if it was
  // soft-deleted concurrently we still want to return an empty page
  // gracefully rather than 404 the comments URL.
  const rows = await prisma.communityComment.findMany({
    where: { postId: id, ...notDeleted() },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit + 1,
    cursor: cursor ? { id: cursor } : undefined,
    skip: cursor ? 1 : 0,
    select: commentBaseSelect,
  });

  let nextCursor: string | undefined;
  if (rows.length > limit) {
    const next = rows.pop();
    nextCursor = next?.id;
  }

  res.json({
    comments: rows.map(shapeComment),
    nextCursor,
  });
});

// POST /community/posts/:id/comments
// Body: { text: string }
communityRouter.post("/posts/:id/comments", async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  if (!isObjectId(id)) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const body = (req.body ?? {}) as { text?: unknown };
  const text = safeString(body.text, COMMENT_MAX);
  if (!text) {
    res.status(400).json({ error: "invalid_comment" });
    return;
  }

  // Bail if the parent post is gone — Prisma would fail on the FK
  // anyway, but we want a clean 404 instead of a 500.
  const post = await prisma.communityPost.findFirst({
    where: { id, ...notDeleted() },
    select: { id: true },
  });
  if (!post) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const created = await prisma.communityComment.create({
    data: { postId: id, userId: req.userId!, text },
    select: commentBaseSelect,
  });

  res.status(201).json({ comment: shapeComment(created) });
});

// DELETE /community/comments/:id
communityRouter.delete("/comments/:id", async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  if (!isObjectId(id)) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const c = await prisma.communityComment.findUnique({
    where: { id },
    select: { userId: true, deletedAt: true },
  });
  if (!c) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (c.userId !== req.userId) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  if (c.deletedAt) {
    res.status(204).end();
    return;
  }
  await prisma.communityComment.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

interface ReportBody {
  reason?: unknown;
  notes?: unknown;
}

function parseReport(body: ReportBody): { reason: string; notes: string | null } | null {
  const reason = safeString(body.reason, REPORT_REASON_MAX);
  if (!reason) return null;
  let notes: string | null = null;
  if (body.notes !== undefined && body.notes !== null) {
    const n = safeString(body.notes, REPORT_NOTES_MAX);
    if (n === null) return null;
    notes = n;
  }
  return { reason, notes };
}

// POST /community/posts/:id/report
communityRouter.post("/posts/:id/report", async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  if (!isObjectId(id)) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const parsed = parseReport((req.body ?? {}) as ReportBody);
  if (!parsed) {
    res.status(400).json({ error: "invalid_report" });
    return;
  }

  const post = await prisma.communityPost.findFirst({
    where: { id, ...notDeleted() },
    select: { id: true },
  });
  if (!post) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  await prisma.communityReport.create({
    data: {
      reason: parsed.reason,
      notes: parsed.notes,
      reporterId: req.userId!,
      postId: id,
    },
    select: { id: true },
  });

  res.status(201).json({ ok: true });
});

// POST /community/comments/:id/report
communityRouter.post("/comments/:id/report", async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  if (!isObjectId(id)) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const parsed = parseReport((req.body ?? {}) as ReportBody);
  if (!parsed) {
    res.status(400).json({ error: "invalid_report" });
    return;
  }

  const c = await prisma.communityComment.findFirst({
    where: { id, ...notDeleted() },
    select: { id: true },
  });
  if (!c) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  await prisma.communityReport.create({
    data: {
      reason: parsed.reason,
      notes: parsed.notes,
      reporterId: req.userId!,
      commentId: id,
    },
    select: { id: true },
  });

  res.status(201).json({ ok: true });
});
