import { createHmac } from "crypto";
import type { IceConfigResponse } from "@rtc/protocol";

const DEFAULT_TURN_TTL_SEC = 3600;

export function getIceConfig(opts: { userId?: string; ttlSec?: number } = {}): IceConfigResponse {
  const iceServers: IceConfigResponse["iceServers"] = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];

  const turnUrl = process.env.TURN_URL;
  // REST/HMAC credentials only work when coturn uses --use-auth-secret.
  // The default compose deployment uses --user and requires static credentials.
  const turnSecret = process.env.TURN_STATIC_AUTH_SECRET;
  if (!turnUrl) return { iceServers };

  if (turnSecret && opts.userId) {
    const ttl = opts.ttlSec ?? DEFAULT_TURN_TTL_SEC;
    const expiry = Math.floor(Date.now() / 1000) + ttl;
    const username = `${expiry}:${opts.userId}`;
    const credential = createHmac("sha1", turnSecret).update(username).digest("base64");
    iceServers.push({ urls: turnUrl, username, credential });
    return { iceServers };
  }

  iceServers.push({
    urls: turnUrl,
    username: process.env.TURN_USERNAME || "rtc",
    credential: process.env.TURN_PASSWORD || "rtc-turn-secret",
  });
  return { iceServers };
}
