// AI-powered food scanner.
//
// One endpoint: `POST /food-scan`. Accepts a single image upload via
// multipart, forwards it to OpenAI's vision-capable chat completions
// API, and returns a fully structured nutrition breakdown the
// Flutter app can render without any post-processing.
//
// Why a dedicated route (not a generic "openai proxy"):
//   1. We can lock the input down to a single small JPEG/PNG/HEIC
//      so a malicious client can't burn through the quota with
//      multi-megabyte uploads or unrelated prompts.
//   2. We can guarantee a strict response shape via the
//      `response_format: { type: "json_schema", strict: true }`
//      mode. That lets the client parse fearlessly: no markdown
//      fences, no missing keys, no narrative paragraphs that drift
//      between calls.
//   3. The OpenAI API key never leaves the server. The Flutter app
//      only ever sees the (validated) JSON result.

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { Request, Response } from "express";
import { Router } from "express";
import multer from "multer";
import OpenAI from "openai";

import {
  recordAiTokenUsageFireAndForget,
  tokensFromCompletion,
} from "../lib/ai_usage.ts";
import { requireAuth } from "../middleware/require_auth.ts";
import { UPLOADS_ROOT } from "./uploads.ts";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export const foodScanRouter: Router = Router();

// 8 MB cap: enough headroom for a high-resolution iPhone photo
// (image_picker re-encodes to JPEG q=80 by default, ~3-4 MB max),
// small enough that even a flaky 3G connection finishes the upload
// in a few seconds.
const MAX_BYTES = 8 * 1024 * 1024;

const ALLOWED_MIMES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

// memoryStorage so we never persist the user's food photo to disk —
// we forward the bytes straight to OpenAI and drop them. The
// per-scan archive is opt-in below (`saveScanCopy`); off by default
// to keep the user's privacy expectations conservative.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
});

// Lazily construct the client so missing keys surface as a 503 at
// scan time instead of a startup crash — dev environments without
// an OPENAI_API_KEY still boot, they just can't scan.
let _client: OpenAI | null = null;
function client(): OpenAI {
  if (_client) return _client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error("OPENAI_API_KEY is not configured");
  }
  _client = new OpenAI({ apiKey });
  return _client;
}

// ---------------------------------------------------------------------------
// JSON schema for the model's output
// ---------------------------------------------------------------------------
//
// OpenAI's `response_format: json_schema` enforces this shape
// server-side. We get back a JSON.stringify-able object that
// matches it exactly — no defensive parsing required on either
// side of the wire.
//
// The schema is deliberately verbose:
//   - `confidence`: how sure the model was that this is food at
//     all. Drives the UI's "We're not certain this is food"
//     warning when below ~0.5.
//   - `servingDescription` + `servingGrams`: human-readable +
//     machine-readable. The app shows the description ("1 medium
//     apple") and uses the grams for any scaling math.
//   - `nutrition`: a flat block of the macros + key micros that
//     actually fit on a one-screen card. Vitamins / minerals are
//     a sub-object so we can render them as a single grid without
//     scattering optional keys across the parent shape.
//   - `ingredients`: bulleted breakdown of what the model thinks
//     is on the plate. Pure metadata for the UI.
//   - `healthScore` (0-100) + `healthNotes` (one-line summary):
//     gives the user something glanceable beyond just numbers.
//
// `additionalProperties: false` on every object is mandatory for
// strict mode (OpenAI's docs are emphatic about this).
const NUTRITION_SCHEMA = {
  name: "food_scan_result",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      isFood: {
        type: "boolean",
        description:
          "True when the image clearly contains food or drink. False for pets, scenery, screenshots, etc.",
      },
      confidence: {
        type: "number",
        description:
          "How confident the model is in the overall identification, 0.0 = guessing, 1.0 = certain.",
      },
      foodName: {
        type: "string",
        description:
          "Short human-readable name of the dish, e.g. 'Grilled chicken caesar salad'. Empty when isFood is false.",
      },
      description: {
        type: "string",
        description:
          "1-2 sentence description of the dish and notable visible components.",
      },
      servingDescription: {
        type: "string",
        description:
          "Natural-language serving size estimate based on what's visible, e.g. '1 medium bowl (~250 g)'.",
      },
      servingGrams: {
        type: "number",
        description: "Estimated serving size in grams.",
      },
      ingredients: {
        type: "array",
        description: "Visible ingredients in the dish, one entry per ingredient.",
        items: { type: "string" },
      },
      nutrition: {
        type: "object",
        additionalProperties: false,
        description:
          "All values are per the estimated serving above (NOT per 100 g).",
        properties: {
          calories: { type: "number", description: "kcal" },
          proteinGrams: { type: "number" },
          carbsGrams: { type: "number" },
          sugarGrams: { type: "number" },
          fiberGrams: { type: "number" },
          fatGrams: { type: "number" },
          saturatedFatGrams: { type: "number" },
          transFatGrams: { type: "number" },
          cholesterolMg: { type: "number" },
          sodiumMg: { type: "number" },
          potassiumMg: { type: "number" },
          calciumMg: { type: "number" },
          ironMg: { type: "number" },
          vitamins: {
            type: "object",
            additionalProperties: false,
            description: "Optional micro-nutrients. Use 0 when negligible.",
            properties: {
              vitaminAMcg: { type: "number" },
              vitaminCMg: { type: "number" },
              vitaminDMcg: { type: "number" },
              vitaminEMg: { type: "number" },
              vitaminKMcg: { type: "number" },
              vitaminB6Mg: { type: "number" },
              vitaminB12Mcg: { type: "number" },
              folateMcg: { type: "number" },
            },
            required: [
              "vitaminAMcg",
              "vitaminCMg",
              "vitaminDMcg",
              "vitaminEMg",
              "vitaminKMcg",
              "vitaminB6Mg",
              "vitaminB12Mcg",
              "folateMcg",
            ],
          },
        },
        required: [
          "calories",
          "proteinGrams",
          "carbsGrams",
          "sugarGrams",
          "fiberGrams",
          "fatGrams",
          "saturatedFatGrams",
          "transFatGrams",
          "cholesterolMg",
          "sodiumMg",
          "potassiumMg",
          "calciumMg",
          "ironMg",
          "vitamins",
        ],
      },
      healthScore: {
        type: "integer",
        description:
          "Holistic 0-100 score reflecting how aligned this meal is with a balanced fitness diet. Higher is better.",
      },
      healthNotes: {
        type: "string",
        description: "1 short sentence explaining the health score.",
      },
      warnings: {
        type: "array",
        description:
          "Caveats the user should know: low confidence, partially hidden, blurry, etc. Empty array when none.",
        items: { type: "string" },
      },
    },
    required: [
      "isFood",
      "confidence",
      "foodName",
      "description",
      "servingDescription",
      "servingGrams",
      "ingredients",
      "nutrition",
      "healthScore",
      "healthNotes",
      "warnings",
    ],
  },
} as const;

// Prompt is short and assertive on purpose. With strict json_schema
// the model can't deviate from the shape, so the only thing this
// has to do is set the *attitude*: estimate freely, never refuse,
// surface uncertainty via `confidence` + `warnings` rather than
// returning a useless response.
const SYSTEM_PROMPT = `You are a nutritionist analysing a single food photo for a fitness app.

Always return values for every field in the schema. Estimate when uncertain
and explain low confidence via the warnings field. If the image is clearly
not food, set isFood=false, foodName="", and zero out the nutrition values.

Base all nutrition values on the estimated serving size (NOT per 100 g).
Round to reasonable precision (one decimal place at most). Be realistic —
don't underestimate calories of fried foods, don't overestimate fibre of
processed foods. healthScore should reward whole, balanced meals and
penalise ultra-processed / high-sugar / high-saturated-fat items.`;

// ---------------------------------------------------------------------------
// Optional archival
// ---------------------------------------------------------------------------
//
// Saving the user's scanned photo to disk is opt-in. Today no
// caller asks for it, but the plumbing is here so a "scan history"
// feature can land later without revisiting the upload pipeline.

const SCANS_DIR = path.join(UPLOADS_ROOT, "scans");

async function saveScanCopy(
  buffer: Buffer,
  mimeType: string,
): Promise<string | null> {
  try {
    await fs.mkdir(SCANS_DIR, { recursive: true });
    const ext = mimeType === "image/png"
      ? ".png"
      : mimeType === "image/webp"
        ? ".webp"
        : mimeType === "image/heic" || mimeType === "image/heif"
          ? ".heic"
          : ".jpg";
    const name = `${randomUUID()}${ext}`;
    await fs.writeFile(path.join(SCANS_DIR, name), buffer);
    return `/files/scans/${name}`;
  } catch (err) {
    console.error("[food-scan] failed to archive scan:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

/**
 * POST /food-scan
 *
 * Body (multipart/form-data):
 *   - file: image/jpeg|png|webp|heic|heif, ≤ 8 MB
 *   - save: "1" to archive the photo for later (default off)
 *
 * Response:
 *   {
 *     scan: { ... matches NUTRITION_SCHEMA ... },
 *     archivedUrl: "/files/scans/..." | null
 *   }
 *
 * Errors:
 *   400 invalid_image       — no file / wrong type / over size limit
 *   503 ai_unavailable      — OPENAI_API_KEY missing or API down
 *   502 ai_invalid_response — OpenAI returned a payload we can't parse
 */
foodScanRouter.post(
  "/",
  requireAuth,
  upload.single("file"),
  async (req: Request, res: Response) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({
        error: "invalid_image",
        message: "Attach a photo as 'file'.",
      });
      return;
    }
    if (!ALLOWED_MIMES.has(file.mimetype)) {
      res.status(400).json({
        error: "invalid_image",
        message: `Unsupported image type: ${file.mimetype}`,
      });
      return;
    }

    let openai: OpenAI;
    try {
      openai = client();
    } catch (err) {
      res.status(503).json({
        error: "ai_unavailable",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // Convert to a data URL — OpenAI's vision input accepts either
    // a remote URL or a base64 data URL. Data URL avoids us having
    // to expose the photo publicly just so the API can fetch it.
    const dataUrl = `data:${file.mimetype};base64,${file.buffer.toString("base64")}`;

    let aiResponseText: string;
    const model = "gpt-4o-mini";
    try {
      const completion = await openai.chat.completions.create({
        model,
        temperature: 0.2,
        response_format: {
          type: "json_schema",
          json_schema: NUTRITION_SCHEMA,
        },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "Analyse this food photo and return the nutrition breakdown matching the schema exactly.",
              },
              {
                type: "image_url",
                image_url: {
                  url: dataUrl,
                  // "low" detail keeps token cost predictable;
                  // food recognition rarely needs high-detail
                  // tiling and the price difference is ~5x.
                  detail: "low",
                },
              },
            ],
          },
        ],
      });
      const content = completion.choices[0]?.message?.content;
      if (typeof content !== "string" || content.length === 0) {
        throw new Error("Empty response from OpenAI");
      }
      aiResponseText = content;

      recordAiTokenUsageFireAndForget({
        source: "food_scan",
        model,
        ...tokensFromCompletion(completion.usage),
        userId: req.userId!,
      });
    } catch (err) {
      console.error("[food-scan] OpenAI call failed:", err);
      res.status(502).json({
        error: "ai_invalid_response",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let scan: unknown;
    try {
      scan = JSON.parse(aiResponseText);
    } catch (err) {
      console.error(
        "[food-scan] could not parse OpenAI JSON:",
        aiResponseText.slice(0, 500),
      );
      res.status(502).json({
        error: "ai_invalid_response",
        message: "Model returned non-JSON content.",
      });
      return;
    }

    const shouldArchive =
      typeof req.body?.save === "string" && req.body.save === "1";
    const archivedUrl = shouldArchive
      ? await saveScanCopy(file.buffer, file.mimetype)
      : null;

    res.json({ scan, archivedUrl });
  },
);
