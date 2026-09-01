/**
 * Generates a JWT for a real user and calls the fitness chat stream
 * endpoint on the local backend to reproduce the internal_error.
 *
 *   bun scripts/test-chat-endpoint.ts
 */
import dotenv from "dotenv";
import { SignJWT } from "jose";

import { prisma } from "../src/lib/prisma.ts";

dotenv.config();

const ISSUER = "fittaz-backend";
const AUDIENCE = "fittaz-app";
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

async function main() {
  // Find a user with a profile
  const user = await prisma.user.findFirst({
    where: { profile: { isNot: null } },
    select: { id: true, email: true },
  });
  if (!user) {
    console.error("No user found");
    process.exit(1);
  }
  console.log(`Using user: ${user.email} (${user.id})`);

  // Generate a JWT
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    console.error("JWT_SECRET missing or too short");
    process.exit(1);
  }
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .sign(new TextEncoder().encode(secret));

  // Call the stream endpoint
  console.log("\nCalling POST /fitness-chat/message/stream...");
  const res = await fetch("http://localhost:3328/fitness-chat/message/stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      Accept: "text/event-stream",
    },
    body: JSON.stringify({ message: "Hi" }),
  });

  console.log(`HTTP Status: ${res.status}`);
  console.log(`Content-Type: ${res.headers.get("content-type")}`);

  if (res.status < 200 || res.status >= 300) {
    const text = await res.text();
    console.log(`Error body: ${text}`);
  } else {
    // Read the SSE stream
    const reader = res.body?.getReader();
    if (!reader) {
      console.error("No response body");
      process.exit(1);
    }
    let full = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = new TextDecoder().decode(value);
      full += chunk;
      process.stdout.write(chunk);
    }
    console.log("\n\n--- Full SSE response ---");
    console.log(full);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
