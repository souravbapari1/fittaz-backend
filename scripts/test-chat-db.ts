/**
 * Tests the full fitness chat DB flow (conversation + message creation)
 * against the real database to find what causes internal_error.
 *
 *   bun scripts/test-chat-db.ts
 */
import dotenv from "dotenv";

import { prisma } from "../src/lib/prisma.ts";
import {
  ageFromDob,
  type FitnessChatUserContext,
} from "../src/lib/fitness_chat_ai.ts";

dotenv.config();

async function main() {
  // Pick the first user with a profile
  const user = await prisma.user.findFirst({
    where: { profile: { isNot: null } },
    select: { id: true, name: true, email: true, profile: true },
  });

  if (!user?.profile) {
    console.error("No user with profile found");
    process.exit(1);
  }

  console.log(`Testing with user: ${user.email} (${user.id})`);

  // Step 1: Build context (same as loadUserContext)
  console.log("\n1. Building user context...");
  try {
    const ctx: FitnessChatUserContext = {
      name: user.name,
      goal: user.profile.goal,
      goals: user.profile.goals,
      gender: user.profile.gender,
      ageYears: ageFromDob(user.profile.dob),
      heightCm: user.profile.heightCm,
      weightKg: user.profile.weightKg,
      targetWeightKg: user.profile.targetWeightKg,
      diet: user.profile.diet,
      allergies: user.profile.allergies,
      about: user.profile.about,
    };
    console.log("   OK:", JSON.stringify(ctx, null, 2));
  } catch (err) {
    console.error("   FAILED:", err);
    process.exit(1);
  }

  // Step 2: Create a conversation
  console.log("\n2. Creating conversation...");
  let conversation;
  try {
    conversation = await prisma.fitnessChatConversation.create({
      data: {
        userId: user.id,
        title: "Test conversation",
      },
      include: { messages: true },
    });
    console.log("   OK:", conversation.id);
  } catch (err) {
    console.error("   FAILED:", err);
    process.exit(1);
  }

  // Step 3: Create a user message
  console.log("\n3. Creating user message...");
  try {
    const userMsg = await prisma.fitnessChatMessage.create({
      data: {
        conversationId: conversation.id,
        role: "user",
        content: "Hi",
      },
    });
    console.log("   OK:", userMsg.id);
  } catch (err) {
    console.error("   FAILED:", err);
    process.exit(1);
  }

  // Step 4: Create an assistant message
  console.log("\n4. Creating assistant message...");
  try {
    const assistantMsg = await prisma.fitnessChatMessage.create({
      data: {
        conversationId: conversation.id,
        role: "assistant",
        content: "Hello! How can I help you?",
      },
    });
    console.log("   OK:", assistantMsg.id);
  } catch (err) {
    console.error("   FAILED:", err);
    process.exit(1);
  }

  // Step 5: Update conversation
  console.log("\n5. Updating conversation...");
  try {
    await prisma.fitnessChatConversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() },
    });
    console.log("   OK");
  } catch (err) {
    console.error("   FAILED:", err);
    process.exit(1);
  }

  // Cleanup: delete the test conversation
  console.log("\n6. Cleaning up test conversation...");
  try {
    await prisma.fitnessChatConversation.delete({
      where: { id: conversation.id },
    });
    console.log("   OK");
  } catch (err) {
    console.error("   FAILED:", err);
  }

  console.log("\nAll DB steps passed! The issue is NOT in the database layer.");
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
