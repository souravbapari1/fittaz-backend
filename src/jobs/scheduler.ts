import { runWeeklyMealPlanJob } from "./weekly_meal_plans.ts";

/** Monday = 1 in JS Date#getDay() (Sunday = 0). */
const DEFAULT_CRON_DAY = 1;
const DEFAULT_CRON_HOUR = 6;
const CHECK_INTERVAL_MS = 15 * 60 * 1000;

let lastRunWeekKey: string | null = null;
let jobInFlight = false;

function weekKeyFor(date: Date): string {
  const d = new Date(date);
  const day = d.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diffToMonday);
  return d.toISOString().slice(0, 10);
}

function parseCronDay(): number {
  const raw = process.env.MEAL_PLAN_CRON_DAY;
  if (!raw) return DEFAULT_CRON_DAY;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 6) {
    console.warn(
      `[meal-plan-cron] invalid MEAL_PLAN_CRON_DAY=${raw}, using Monday (${DEFAULT_CRON_DAY})`,
    );
    return DEFAULT_CRON_DAY;
  }
  return n;
}

function parseCronHour(): number {
  const raw = process.env.MEAL_PLAN_CRON_HOUR;
  if (!raw) return DEFAULT_CRON_HOUR;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 23) {
    console.warn(
      `[meal-plan-cron] invalid MEAL_PLAN_CRON_HOUR=${raw}, using ${DEFAULT_CRON_HOUR}:00`,
    );
    return DEFAULT_CRON_HOUR;
  }
  return n;
}

function isCronEnabled(): boolean {
  const raw = process.env.MEAL_PLAN_CRON_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

async function maybeRunWeeklyMealPlans(now = new Date()): Promise<void> {
  if (!isCronEnabled() || jobInFlight) return;

  const cronDay = parseCronDay();
  const cronHour = parseCronHour();
  if (now.getDay() !== cronDay || now.getHours() !== cronHour) {
    return;
  }

  const weekKey = weekKeyFor(now);
  if (lastRunWeekKey === weekKey) {
    return;
  }

  jobInFlight = true;
  lastRunWeekKey = weekKey;
  try {
    await runWeeklyMealPlanJob(now);
  } catch (err) {
    // Allow a retry later the same hour if the whole job crashed.
    lastRunWeekKey = null;
    console.error("[meal-plan-cron] job crashed:", err);
  } finally {
    jobInFlight = false;
  }
}

/**
 * Start the in-process weekly meal-plan scheduler.
 *
 * Enabled with `MEAL_PLAN_CRON_ENABLED=true`. Defaults to every Monday at
 * 06:00 server local time. Override with:
 *   MEAL_PLAN_CRON_DAY=1    (0=Sun … 6=Sat)
 *   MEAL_PLAN_CRON_HOUR=6   (0–23)
 */
export function startMealPlanCron(): void {
  if (!isCronEnabled()) {
    console.log(
      "[meal-plan-cron] disabled (set MEAL_PLAN_CRON_ENABLED=true to enable)",
    );
    return;
  }

  const day = parseCronDay();
  const hour = parseCronHour();
  console.log(
    `[meal-plan-cron] enabled — runs weekly on day=${day} at ${hour}:00 (server local time)`,
  );

  void maybeRunWeeklyMealPlans();
  setInterval(() => {
    void maybeRunWeeklyMealPlans();
  }, CHECK_INTERVAL_MS);
}
