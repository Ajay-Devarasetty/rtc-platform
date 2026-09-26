import type { FastifyInstance } from "fastify";
import { issueToken } from "../auth.js";
import { getBillingSummary } from "../billing.js";
import { authenticateCustomer, createCustomerAccount } from "../customers.js";
import { rateLimit } from "../rate-limit.js";

const AUTH_LIMIT = 10;
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const PORTAL_USER_ID = "__portal__";
const PORTAL_TOKEN_TTL_SEC = 24 * 60 * 60;

function portalSession(account: { appId: string; appName: string; email: string; sessionVersion?: number }, jwtSecret: string) {
  const token = issueToken(
    { appId: account.appId, userId: PORTAL_USER_ID, role: "host", sessionVersion: account.sessionVersion ?? 0 },
    jwtSecret,
    PORTAL_TOKEN_TTL_SEC
  );
  return { token, expiresIn: PORTAL_TOKEN_TTL_SEC };
}

export async function registerAuthRoutes(app: FastifyInstance, jwtSecret: string) {
  app.post<{
    Body: { email?: string; password?: string; name?: string; company?: string };
  }>("/v1/auth/signup", async (req, reply) => {
    if (!rateLimit(`auth-signup:${req.ip}`, AUTH_LIMIT, AUTH_WINDOW_MS)) {
      return reply.status(429).send({ error: "Too many signup attempts. Try again later." });
    }

    const email = req.body?.email?.trim();
    const password = req.body?.password || "";
    if (!email || !password) {
      return reply.status(400).send({ error: "email and password are required" });
    }

    try {
      const created = await createCustomerAccount({
        email,
        password,
        name: req.body?.name,
        company: req.body?.company,
      });
      const billing = await getBillingSummary(created.appId);
      const session = portalSession(
        { appId: created.appId, appName: created.appName, email: created.email },
        jwtSecret
      );

      return reply.status(201).send({
        ...session,
        email: created.email,
        name: created.name,
        company: created.company,
        appId: created.appId,
        appSecret: created.appSecret,
        appName: created.appName,
        plan: billing.plan,
        planName: billing.planName,
        message:
          "Account created. Copy your App Secret now — it is shown only once and cannot be retrieved later.",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Signup failed";
      const status = message.includes("already exists") ? 409 : 400;
      return reply.status(status).send({ error: message });
    }
  });

  app.post<{ Body: { email?: string; password?: string } }>("/v1/auth/login", async (req, reply) => {
    if (!rateLimit(`auth-login:${req.ip}`, AUTH_LIMIT, AUTH_WINDOW_MS)) {
      return reply.status(429).send({ error: "Too many login attempts. Try again later." });
    }

    const email = req.body?.email?.trim();
    const password = req.body?.password || "";
    if (!email || !password) {
      return reply.status(400).send({ error: "email and password are required" });
    }

    try {
      const account = await authenticateCustomer(email, password);
      if (!account) {
        return reply.status(401).send({ error: "Invalid email or password" });
      }

      const billing = await getBillingSummary(account.appId);
      const session = portalSession(account, jwtSecret);

      return {
        ...session,
        email: account.email,
        name: account.name,
        company: account.company,
        appId: account.appId,
        appName: account.appName,
        plan: billing.plan,
        planName: billing.planName,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Login failed";
      return reply.status(503).send({ error: message });
    }
  });
}
