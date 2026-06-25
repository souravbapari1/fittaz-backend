import cors from "cors";
import express from "express";
import dotenv from "dotenv";
import type { NextFunction, Request, Response } from "express";
import { prisma } from "./src/lib/prisma.ts";
import { authRouter } from "./src/routes/auth.ts";
import { communityRouter } from "./src/routes/community.ts";
import { fitnessChatRouter } from "./src/routes/fitness_chat.ts";
import { foodScanRouter } from "./src/routes/food_scan.ts";
import { mealIntakeRouter } from "./src/routes/meal_intake.ts";
import { meRouter } from "./src/routes/me.ts";
import { meditationsRouter } from "./src/routes/meditations.ts";
import { nutritionRouter } from "./src/routes/nutrition.ts";
import { notificationsRouter } from "./src/routes/notifications.ts";
import { paymentsRouter } from "./src/routes/payments.ts";
import { plansRouter } from "./src/routes/plans.ts";
import { progressPhotosRouter } from "./src/routes/progress_photos.ts";
import { recipesRouter } from "./src/routes/recipes.ts";
import { UPLOADS_ROOT, uploadsRouter } from "./src/routes/uploads.ts";
import { stepsRouter } from "./src/routes/steps.ts";
import { userReportRouter } from "./src/routes/user_report.ts";
import { waterRouter } from "./src/routes/water.ts";
import { workoutCompletionRouter } from "./src/routes/workout_completion.ts";
import { startMealPlanCron } from "./src/jobs/scheduler.ts";

dotenv.config();

const app = express();

// Permissive CORS in dev so the admin (different port) and the Flutter
// web build can both call the API. For production this should be
// tightened to an explicit list via env, e.g.:
//   CORS_ORIGINS=https://admin.fittaz.com,https://app.fittaz.com
const allowedOrigins = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : true,
    credentials: true,
  }),
);

app.use(express.json({ limit: "256kb" }));

app.get("/health", async (_req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok", db: "up" });
  } catch (err) {
    res.status(503).json({
      status: "degraded",
      db: "down",
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.use("/auth", authRouter);
app.use("/me", meRouter);
app.use("/notifications", notificationsRouter);
app.use("/plans", plansRouter);
app.use("/payments", paymentsRouter);
app.use("/uploads", uploadsRouter);
app.use("/community", communityRouter);
app.use("/water", waterRouter);
app.use("/steps", stepsRouter);
app.use("/progress-photos", progressPhotosRouter);
app.use("/recipes", recipesRouter);
app.use("/nutrition", nutritionRouter);
app.use("/meditations", meditationsRouter);
app.use("/food-scan", foodScanRouter);
app.use("/fitness-chat", fitnessChatRouter);
app.use("/meal-intake", mealIntakeRouter);
app.use("/workout-completion", workoutCompletionRouter);
app.use("/report", userReportRouter);

// Public read-only file server for everything in `backend/uploads/`.
// Served at `/files/<kind>/<filename>` so consumers (Flutter, admin
// previews) can fetch media without going through the JSON API.
//
// `maxAge` is a week — these filenames are content-addressed (random
// cuid + ext), so an aggressive cache is safe; a new upload always gets
// a new URL.
app.use(
  "/files",
  express.static(UPLOADS_ROOT, {
    fallthrough: false,
    index: false,
    maxAge: "7d",
  }),
);

// Catch-all error handler. Express 5 forwards async rejections here, so we
// don't need a try/catch in every route.
//
// We respect a `status`/`statusCode` field on the error when present —
// `express.static` (via serve-static) throws a NotFoundError with
// statusCode 404 for missing files; without this branch every missing
// /files/... URL would 500 instead of 404.
app.use(
  (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    const e = err as { status?: number; statusCode?: number; message?: string };
    const status = e.status ?? e.statusCode ?? 500;
    if (status >= 500) {
      console.error("[backend] unhandled error:", err);
    }
    res.status(status).json({
      error: status === 404 ? "not_found" : "internal_error",
      message: e.message ?? String(err),
    });
  },
);

const port = Number(process.env.PORT ?? 4040);
const server = app.listen(port, () => {
  console.log(`[backend] listening on http://localhost:${port}`);
  startMealPlanCron();
});

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  console.log(`[backend] received ${signal}, shutting down`);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
