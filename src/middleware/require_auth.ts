import type { NextFunction, Request, Response } from "express";
import { verifyToken } from "../lib/auth.ts";

// Attach `req.userId` for any handler mounted behind requireAuth. Using a
// module-augmentation keeps the types honest without sprinkling `as any`.
declare module "express-serve-static-core" {
  interface Request {
    userId?: string;
  }
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.toLowerCase().startsWith("bearer ")) {
    res.status(401).json({ error: "missing_bearer_token" });
    return;
  }
  const token = header.slice("bearer ".length).trim();
  try {
    const payload = await verifyToken(token);
    req.userId = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: "invalid_token" });
  }
}
