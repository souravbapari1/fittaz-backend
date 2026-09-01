/**
 * Smoke test for the fitness chat AI path.
 *
 *   bun scripts/test-fitness-chat.ts
 *
 * Loads .env and calls OpenAI directly. This isolates whether the issue is
 * the OpenAI key/response or the surrounding HTTP/Prisma code.
 */
import dotenv from "dotenv";

import {
  generateFitnessChatReply,
  type FitnessChatUserContext,
} from "../src/lib/fitness_chat_ai.ts";

dotenv.config();

const ctx: FitnessChatUserContext = {
  name: "Test User",
  goal: "Lose weight",
  goals: ["Lose weight"],
  gender: "female",
  ageYears: 30,
  heightCm: 165,
  weightKg: 70,
  targetWeightKg: 65,
  diet: "vegetarian",
  allergies: ["nuts"],
  about: null,
  mealPlanTitle: null,
  mealPlanNotes: null,
};

try {
  const reply = await generateFitnessChatReply(
    ctx,
    [],
    "Suggest a quick home workout",
    { userId: "test-user" },
  );
  console.log("--- REPLY ---");
  console.log(reply);
} catch (err) {
  console.error("--- ERROR ---");
  console.error(err);
  process.exit(1);
}
