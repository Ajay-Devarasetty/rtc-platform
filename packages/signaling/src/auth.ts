import jwt from "jsonwebtoken";
import type { TokenClaims } from "@rtc/protocol";

export function issueToken(
  input: { appId: string; userId: string; roomId?: string; role?: string; sessionVersion?: number },
  secret: string,
  expiresInSeconds = 3600
) {
  const payload: Omit<TokenClaims, "iat" | "exp"> & { sessionVersion?: number } = {
    appId: input.appId,
    userId: input.userId,
    roomId: input.roomId,
    role: input.role as TokenClaims["role"],
    sessionVersion: input.sessionVersion,
  };
  return jwt.sign(payload, secret, { expiresIn: expiresInSeconds });
}

export function verifyToken(token: string, secret: string): TokenClaims {
  const claims = jwt.verify(token, secret, { algorithms: ["HS256"] }) as TokenClaims;
  if (typeof claims.appId !== "string" || !claims.appId || typeof claims.userId !== "string" || !claims.userId ||
      (claims.roomId !== undefined && (typeof claims.roomId !== "string" || !claims.roomId)) ||
      (claims.role !== undefined && !["host", "publisher", "subscriber", "audience"].includes(claims.role))) {
    throw new Error("Invalid token claims");
  }
  return claims;
}
