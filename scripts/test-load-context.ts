/**
 * Tests loadUserContext against real users in the database to find
 * which user/profile combination causes the internal_error.
 *
 *   bun scripts/test-load-context.ts
 */
import dotenv from "dotenv";

import { prisma } from "../src/lib/prisma.ts";

dotenv.config();

async function main() {
  // Find all users that have a profile
  const users = await prisma.user.findMany({
    where: { profile: { isNot: null } },
    select: {
      id: true,
      name: true,
      email: true,
      profile: true,
    },
    take: 20,
  });

  console.log(`Found ${users.length} users with profiles`);

  for (const user of users) {
    console.log(`\n--- User: ${user.email} (${user.id}) ---`);
    const profile = user.profile;
    if (!profile) {
      console.log("  no profile, skipping");
      continue;
    }

    // Check each field that loadUserContext accesses
    const fields: Array<[string, unknown]> = [
      ["goal", profile.goal],
      ["goals", profile.goals],
      ["gender", profile.gender],
      ["dob", profile.dob],
      ["heightCm", profile.heightCm],
      ["weightKg", profile.weightKg],
      ["targetWeightKg", profile.targetWeightKg],
      ["diet", profile.diet],
      ["allergies", profile.allergies],
      ["about", profile.about],
    ];

    let hasNull = false;
    for (const [name, value] of fields) {
      const isNull = value === null || value === undefined;
      if (isNull) {
        hasNull = true;
        console.log(`  NULL FIELD: ${name} = ${value}`);
      }
    }

    if (!hasNull) {
      console.log("  all fields present");
    }

    // Try to compute age from dob
    if (profile.dob) {
      const age = new Date().getFullYear() - profile.dob.getFullYear();
      console.log(`  age from dob: ${age}`);
    } else {
      console.log(`  CANNOT COMPUTE AGE - dob is ${profile.dob}`);
    }
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
