import { FcmClient } from "./fcm";
import { sendApns } from "./apns";
import { RateLimiter } from "./ratelimit";
import { validateSendRequest } from "./validate";
import type { SendResponse, Verdict } from "./types";

export interface Env {
  FCM_SERVICE_ACCOUNT: string;
  RATE_LIMIT_PER_IP?: string; // requests/hour, default 1000 (env vars arrive as strings)
  RATE_LIMIT_PER_TOKEN?: string; // sends/hour,    default 60
}

const HOUR_MS = 3_600_000;
// Module-scope: isolate-local by design. See README §Rate limiting.
let ipLimiter: RateLimiter | null = null;
let tokenLimiter: RateLimiter | null = null;
let fcm: FcmClient | null = null;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") return Response.json({ ok: true });
    if (request.method === "POST" && url.pathname === "/v1/send") return handleSend(request, env);
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function handleSend(request: Request, env: Env): Promise<Response> {
  ipLimiter ??= new RateLimiter({ limit: intEnv(env.RATE_LIMIT_PER_IP, 1000), windowMs: HOUR_MS });
  tokenLimiter ??= new RateLimiter({ limit: intEnv(env.RATE_LIMIT_PER_TOKEN, 60), windowMs: HOUR_MS });
  fcm ??= new FcmClient(env.FCM_SERVICE_ACCOUNT);

  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (!ipLimiter.tryAcquire(ip)) {
    return new Response(null, { status: 429, headers: { "retry-after": "3600" } });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const v = validateSendRequest(body);
  if (!v.ok) return Response.json({ error: v.message }, { status: v.status });

  const fcmClient = fcm;
  const results: SendResponse["results"] = [];
  for (const t of v.value.tokens) {
    let status: Verdict;
    if (!tokenLimiter.tryAcquire(t.token)) status = "retryable";
    else if (t.platform === "ios") status = sendApns();
    else status = await sendFcm(fcmClient, t.token, v.value.payload, v.value.collapseKey);
    results.push({ token: t.token, status });
  }
  ipLimiter.prune();
  tokenLimiter.prune();
  return Response.json({ results } satisfies SendResponse);
}

/** FcmClient.send propagates transport throws (documented contract) — map them here, without logging anything request-derived. */
async function sendFcm(
  client: FcmClient,
  token: string,
  payload: Record<string, unknown>,
  collapseKey?: string,
): Promise<Verdict> {
  try {
    return await client.send(token, payload, collapseKey);
  } catch {
    return "retryable"; // transport failure reaching Google — caller may retry
  }
}

export function intEnv(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? NaN : parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
