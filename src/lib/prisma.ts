import { PrismaClient } from "../../generated/prisma/index.js";

// MongoDB: Prisma 6 connects directly — no driver adapter required.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export type { PrismaClient };
