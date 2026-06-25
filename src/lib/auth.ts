import { SignJWT, jwtVerify } from "jose";

// All auth primitives live here so route handlers stay declarative.
// - Passwords are hashed with argon2id via Bun's built-in `Bun.password` —
//   no extra dependency, constant-time verification, sensible defaults.
// - JWTs are HS256 over the shared secret in process.env.JWT_SECRET.

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const ISSUER = "fittaz-backend";
const AUDIENCE = "fittaz-app";

function getSigningKey(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "JWT_SECRET is missing or too short (need >=32 chars). Set it in .env.",
    );
  }
  return new TextEncoder().encode(secret);
}

export interface AuthTokenPayload {
  sub: string; // user id
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

export async function signToken(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .sign(getSigningKey());
}

export async function verifyToken(token: string): Promise<AuthTokenPayload> {
  const { payload } = await jwtVerify(token, getSigningKey(), {
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  if (typeof payload.sub !== "string") {
    throw new Error("Token missing subject");
  }
  return payload as AuthTokenPayload;
}

export async function hashPassword(plain: string): Promise<string> {
  return Bun.password.hash(plain, { algorithm: "argon2id" });
}

export async function verifyPassword(
  plain: string,
  hash: string,
): Promise<boolean> {
  try {
    return await Bun.password.verify(plain, hash);
  } catch {
    return false;
  }
}
