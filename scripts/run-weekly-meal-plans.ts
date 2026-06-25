/**
 * Manual entry point for the weekly meal-plan job.
 *
 *   bun run jobs:meal-plans
 */
import dotenv from "dotenv";

import { runWeeklyMealPlanJob } from "../src/jobs/weekly_meal_plans.ts";
import { prisma } from "../src/lib/prisma.ts";

dotenv.config();

const result = await runWeeklyMealPlanJob();
console.log(JSON.stringify(result, null, 2));
await prisma.$disconnect();
