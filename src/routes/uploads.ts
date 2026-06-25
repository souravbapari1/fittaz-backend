// Media library backend.
//
// Owns the on-disk content (videos / pdfs / images) so the rest of the
// system has a single source of truth. The Flutter app reads files via
// the static `/files/...` route; the admin uploads / lists / deletes
// via the JSON routes below.
//
// Layout on disk (relative to the backend's cwd):
//
//   uploads/
//     videos/
//       <cuid>.<ext>        ← the actual bytes
//       <cuid>.<ext>.json   ← sidecar with { title, originalName }
//     pdfs/
//     images/
//
// Sidecars hold the human-facing title (and the operator-supplied
// original filename) so we can rename an asset without rewriting the
// URL it lives at. Missing sidecars are tolerated — list falls back
// to the original filename as the title for legacy uploads.
//
// Filenames are server-generated (cuid + original extension) so two
// users can upload `IMG_1234.jpg` without colliding and so client-
// supplied paths can never escape the kind's folder via `..`.

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { Request, Response } from "express";
import { Router } from "express";
import multer from "multer";

// =============================================================================
// Kinds (videos / pdfs / images)
// =============================================================================

// Two flavours of kinds live in this folder:
//
//   "Raw" buckets (`videos`, `pdfs`, `images`) — organised by file
//   type. Used by anything that needs a generic store: workout demos,
//   blog hero shots, plan covers.
//
//   "Domain" buckets (`recipes`, `nutrition`, `meditation`) —
//   organised by the user-facing purpose. Same on-disk layout, but
//   the URL semantics carry the intent (`/files/meditation/relax.mp3`
//   reads better in a workout JSON than `/files/audio/relax.mp3`),
//   and operators don't have to remember which PDF goes where —
//   the bucket itself is the answer.
export type UploadKind =
  | "videos"
  | "pdfs"
  | "images"
  | "recipes"
  | "nutrition"
  | "meditation";

interface KindConfig {
  // Hard upload cap. Per-kind because a 500 MB image is almost always
  // a misclick, but a 500 MB video is a legitimate workout demo.
  maxBytes: number;
  // Allowed MIME types. Multer matches the browser-supplied
  // Content-Type; we also validate the file extension below as a
  // belt-and-braces check (some clients lie about MIME).
  mimes: ReadonlySet<string>;
  // Allowed extensions, lowercased, leading dot. Used both to derive
  // the stored filename and to reject suspicious uploads.
  exts: ReadonlySet<string>;
}

const KIND_CONFIG: Record<UploadKind, KindConfig> = {
  videos: {
    maxBytes: 500 * 1024 * 1024, // 500 MB
    mimes: new Set([
      "video/mp4",
      "video/quicktime",
      "video/webm",
      "video/x-matroska",
    ]),
    exts: new Set([".mp4", ".mov", ".webm", ".mkv"]),
  },
  pdfs: {
    maxBytes: 50 * 1024 * 1024, // 50 MB
    mimes: new Set(["application/pdf"]),
    exts: new Set([".pdf"]),
  },
  images: {
    maxBytes: 10 * 1024 * 1024, // 10 MB
    mimes: new Set([
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "image/svg+xml",
      // HEIC / HEIF are the default on every iPhone shot after iOS 11.
      // Without them, photos picked from the Camera Roll on iOS get
      // rejected with `415 unsupported_type` and the user just sees
      // "Could not post" — silent and confusing.
      "image/heic",
      "image/heif",
    ]),
    exts: new Set([
      ".jpg",
      ".jpeg",
      ".png",
      ".webp",
      ".gif",
      ".svg",
      ".heic",
      ".heif",
    ]),
  },

  // ---- Domain buckets --------------------------------------------------
  //
  // Recipes + nutrition mirror the `pdfs` ruleset on purpose — both
  // ship as PDF ebooks today. Splitting them into their own folders
  // is purely a content-organisation move (URLs, admin tabs, easy
  // backups per product line). If a future course needs videos, we
  // can broaden the allowlist or add a sibling bucket without
  // disturbing what's already stored.
  recipes: {
    maxBytes: 50 * 1024 * 1024, // 50 MB
    mimes: new Set(["application/pdf"]),
    exts: new Set([".pdf"]),
  },
  nutrition: {
    maxBytes: 50 * 1024 * 1024, // 50 MB
    mimes: new Set(["application/pdf"]),
    exts: new Set([".pdf"]),
  },
  // Meditation tracks. Limit is generous (200 MB) because guided
  // sessions can run 30–60 minutes at a quality bar that musicians
  // would recognise. mp3/m4a are the common iOS/Android exports;
  // wav covers studio masters; ogg/aac cover Android-native
  // captures.
  meditation: {
    maxBytes: 200 * 1024 * 1024, // 200 MB
    mimes: new Set([
      "audio/mpeg",
      "audio/mp3",
      "audio/mp4",
      "audio/x-m4a",
      "audio/m4a",
      "audio/wav",
      "audio/x-wav",
      "audio/ogg",
      "audio/aac",
      "audio/x-aac",
      "audio/flac",
      "audio/x-flac",
    ]),
    exts: new Set([
      ".mp3",
      ".m4a",
      ".mp4",
      ".wav",
      ".ogg",
      ".aac",
      ".flac",
    ]),
  },
};

// Derived from KIND_CONFIG so adding a new bucket only requires a
// single edit above — no stale string allowlist to keep in sync.
const KIND_NAMES = new Set<string>(Object.keys(KIND_CONFIG));

function isKind(value: string): value is UploadKind {
  return KIND_NAMES.has(value);
}

// Maximum upload size across all kinds — multer needs ONE upper bound
// up-front because limits.fileSize is set per Multer instance, not per
// request. We enforce the per-kind cap below in `validateUpload`.
const GLOBAL_MAX_BYTES = Math.max(
  ...Object.values(KIND_CONFIG).map((c) => c.maxBytes),
);

// =============================================================================
// Storage
// =============================================================================

export const UPLOADS_ROOT = path.resolve(process.cwd(), "uploads");

async function ensureKindDir(kind: UploadKind): Promise<string> {
  const dir = path.join(UPLOADS_ROOT, kind);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Generate a URL-safe filename that never collides with another upload
 * and can't be used for path traversal — we only ever keep the
 * extension from the client-supplied name, and even that goes through
 * the kind's allowlist.
 */
function makeStoredName(originalName: string, kind: UploadKind): string {
  const ext = path.extname(originalName).toLowerCase();
  const safeExt = KIND_CONFIG[kind].exts.has(ext) ? ext : "";
  // 16 bytes of entropy → base64url ≈ 22 chars. Plenty for collision
  // resistance and short enough to fit in a URL pasted into chat.
  const slug = randomBytes(16).toString("base64url");
  return `${slug}${safeExt}`;
}

// Multer is configured with memoryStorage rather than diskStorage so
// we can validate MIME / size / kind BEFORE writing anything to disk.
// A rejected upload leaves zero footprint on the filesystem.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: GLOBAL_MAX_BYTES, files: 1 },
});

// =============================================================================
// Sidecar metadata
// =============================================================================
//
// Each upload `xyz.mp4` gets a sibling `xyz.mp4.json` containing
// `{ title, originalName }`. The file bytes are the source of truth
// for "does this asset exist"; the sidecar is the source of truth for
// "what should we call it in the UI".
//
// Read failures (missing file, bad JSON) are non-fatal — the asset
// stays listed with the original filename as the title. This keeps
// the system tolerant of files dropped in by hand or copied over
// from another environment.

const MAX_TITLE_LEN = 200;

interface SidecarMeta {
  title: string;
  originalName: string;
}

function sidecarPath(fileFullPath: string): string {
  return `${fileFullPath}.json`;
}

async function readSidecar(fileFullPath: string): Promise<Partial<SidecarMeta>> {
  try {
    const raw = await fs.readFile(sidecarPath(fileFullPath), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      const p = parsed as Record<string, unknown>;
      return {
        title: typeof p.title === "string" ? p.title : undefined,
        originalName: typeof p.originalName === "string" ? p.originalName : undefined,
      };
    }
  } catch {
    // Missing or corrupt sidecar — fall through to the empty default.
    // Don't log: legacy uploads without sidecars are expected and
    // we'd spam the console at boot.
  }
  return {};
}

async function writeSidecar(fileFullPath: string, meta: SidecarMeta): Promise<void> {
  await fs.writeFile(
    sidecarPath(fileFullPath),
    JSON.stringify(meta, null, 2),
    "utf8",
  );
}

function normaliseTitle(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, MAX_TITLE_LEN);
}

// =============================================================================
// Router
// =============================================================================

export const uploadsRouter: Router = Router();

/**
 * `GET /uploads/:kind`
 *
 * List every file in the kind's folder with filename, byte size, mtime,
 * and the public URL the Flutter app should hit. The list is sorted
 * newest-first so a freshly uploaded asset shows up at the top of the
 * admin grid without an extra refresh.
 */
uploadsRouter.get("/:kind", async (req: Request, res: Response) => {
  const { kind } = req.params as { kind: string };
  if (!isKind(kind)) {
    res.status(400).json({ error: "invalid_kind", message: `Unknown kind: ${kind}` });
    return;
  }

  const dir = await ensureKindDir(kind);
  const entries = await fs.readdir(dir);

  // Sidecars are filtered out of the asset list — they're metadata
  // ABOUT a file, not files themselves. We also skip dotfiles
  // (.gitkeep, .DS_Store, etc).
  const assets = await Promise.all(
    entries
      .filter((name) => !name.startsWith(".") && !name.endsWith(".json"))
      .map(async (name) => {
        const full = path.join(dir, name);
        const [stat, meta] = await Promise.all([fs.stat(full), readSidecar(full)]);
        return {
          name,
          size: stat.size,
          mtime: stat.mtimeMs,
          // Title falls back through: sidecar → original filename → on-disk name.
          title: meta.title ?? meta.originalName ?? name,
          originalName: meta.originalName ?? name,
        };
      }),
  );

  // newest first — a freshly uploaded asset should always be at the
  // top of the admin grid.
  assets.sort((a, b) => b.mtime - a.mtime);

  const base = publicBaseUrl(req);
  const files = assets.map(({ name, size, mtime, title, originalName }) => ({
    filename: name,
    title,
    originalName,
    size,
    mtime: new Date(mtime).toISOString(),
    url: `${base}/files/${kind}/${name}`,
  }));

  res.json({ kind, files });
});

/**
 * `POST /uploads/:kind`
 *
 * Multipart upload. Field name MUST be `file`. The original filename is
 * preserved only in the response so admins can recognise what they just
 * uploaded; on disk the file gets a server-generated name to prevent
 * collisions and path traversal.
 */
uploadsRouter.post(
  "/:kind",
  upload.single("file"),
  async (req: Request, res: Response) => {
    const { kind } = req.params as { kind: string };
    if (!isKind(kind)) {
      res.status(400).json({ error: "invalid_kind", message: `Unknown kind: ${kind}` });
      return;
    }

    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "missing_file", message: "Field 'file' is required" });
      return;
    }

    const config = KIND_CONFIG[kind];

    if (file.size > config.maxBytes) {
      res.status(413).json({
        error: "file_too_large",
        message: `${kind} uploads must be ≤ ${humanSize(config.maxBytes)}`,
        actualBytes: file.size,
      });
      return;
    }

    const ext = path.extname(file.originalname).toLowerCase();
    if (!config.mimes.has(file.mimetype) || !config.exts.has(ext)) {
      res.status(415).json({
        error: "unsupported_type",
        message: `${kind} accepts only: ${[...config.exts].join(", ")}`,
        receivedMime: file.mimetype,
        receivedExt: ext,
      });
      return;
    }

    const dir = await ensureKindDir(kind);
    const stored = makeStoredName(file.originalname, kind);
    const full = path.join(dir, stored);

    // The title comes alongside the file as another multipart field.
    // Operators can leave it blank — we fall back to the original
    // filename, which is what they'd type 90% of the time anyway.
    const title = normaliseTitle(req.body?.title, file.originalname);

    await fs.writeFile(full, file.buffer);
    // Sidecar is written AFTER the bytes are safely on disk. If the
    // sidecar fails the file still exists and is listable (just with
    // its original name as title) — much less bad than the inverse.
    try {
      await writeSidecar(full, { title, originalName: file.originalname });
    } catch (e) {
      console.warn("[uploads] failed to write sidecar:", e);
    }

    const base = publicBaseUrl(req);
    res.status(201).json({
      kind,
      filename: stored,
      title,
      originalName: file.originalname,
      size: file.size,
      mtime: new Date().toISOString(),
      url: `${base}/files/${kind}/${stored}`,
    });
  },
);

/**
 * `PATCH /uploads/:kind/:filename`
 *
 * Body: `{ title: string }`. Rewrites the sidecar with a new title.
 * Used by the admin's inline rename — the file on disk stays put so
 * any existing references (workout videoUrl, blog hero src) keep
 * resolving.
 */
uploadsRouter.patch("/:kind/:filename", async (req: Request, res: Response) => {
  const { kind, filename } = req.params as { kind: string; filename: string };
  if (!isKind(kind)) {
    res.status(400).json({ error: "invalid_kind", message: `Unknown kind: ${kind}` });
    return;
  }

  const safeName = path.basename(filename);
  if (safeName !== filename || safeName.startsWith(".") || safeName.endsWith(".json")) {
    res.status(400).json({ error: "invalid_filename" });
    return;
  }

  const dir = await ensureKindDir(kind);
  const target = path.resolve(dir, safeName);
  if (!target.startsWith(dir + path.sep)) {
    res.status(400).json({ error: "invalid_filename" });
    return;
  }

  // The file itself must still exist — renaming a sidecar for a file
  // we've already deleted would create a phantom asset that GET would
  // never surface.
  try {
    await fs.access(target);
  } catch {
    res.status(404).json({ error: "not_found", message: "File does not exist" });
    return;
  }

  const existing = await readSidecar(target);
  const title = normaliseTitle(req.body?.title, existing.originalName ?? safeName);

  try {
    await writeSidecar(target, {
      title,
      originalName: existing.originalName ?? safeName,
    });
  } catch (e) {
    res.status(500).json({
      error: "sidecar_write_failed",
      message: e instanceof Error ? e.message : String(e),
    });
    return;
  }

  const stat = await fs.stat(target);
  const base = publicBaseUrl(req);
  res.json({
    kind,
    filename: safeName,
    title,
    originalName: existing.originalName ?? safeName,
    size: stat.size,
    mtime: new Date(stat.mtimeMs).toISOString(),
    url: `${base}/files/${kind}/${safeName}`,
  });
});

/**
 * `DELETE /uploads/:kind/:filename`
 *
 * Removes a file. We re-derive the absolute path and verify the
 * resolved location is still inside the kind's folder — defence-in-
 * depth in case the filename slips a `..` past the basename guard.
 */
uploadsRouter.delete("/:kind/:filename", async (req: Request, res: Response) => {
  const { kind, filename } = req.params as { kind: string; filename: string };
  if (!isKind(kind)) {
    res.status(400).json({ error: "invalid_kind", message: `Unknown kind: ${kind}` });
    return;
  }

  // path.basename() strips any directory components a client might try
  // to sneak in (e.g. "../../etc/passwd").
  const safeName = path.basename(filename);
  if (safeName !== filename || safeName.startsWith(".")) {
    res.status(400).json({ error: "invalid_filename" });
    return;
  }

  const dir = await ensureKindDir(kind);
  const target = path.resolve(dir, safeName);
  if (!target.startsWith(dir + path.sep)) {
    res.status(400).json({ error: "invalid_filename" });
    return;
  }

  try {
    await fs.unlink(target);
    // Best-effort sidecar cleanup. A missing sidecar is fine (legacy
    // files won't have one); any other error gets a warning but
    // doesn't fail the user's delete — the file IS gone, which is
    // what they asked for.
    try {
      await fs.unlink(sidecarPath(target));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[uploads] failed to remove sidecar:", e);
      }
    }
    res.json({ kind, filename: safeName });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      res.status(404).json({ error: "not_found", message: "File does not exist" });
      return;
    }
    throw e;
  }
});

// =============================================================================
// Helpers
// =============================================================================

/**
 * Build the absolute base URL the client should hit to fetch a file.
 *
 * In dev this is just `http://localhost:4040`. Behind a reverse proxy
 * we honour the standard `X-Forwarded-*` headers so generated URLs
 * survive TLS termination at the edge.
 */
function publicBaseUrl(req: Request): string {
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() ??
    req.protocol;
  const host =
    (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim() ??
    req.get("host") ??
    `localhost:${process.env.PORT ?? 4040}`;
  return `${proto}://${host}`;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
