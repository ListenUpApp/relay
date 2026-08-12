import { FcmClient } from "./fcm";
import { ApnsClient, apnsConfigFromEnv } from "./apns";
import type { ApnsEnv } from "./apns";
import { RateLimiter } from "./ratelimit";
import { validateSendRequest } from "./validate";
import type { SendResponse, Verdict } from "./types";

export interface Env extends ApnsEnv {
  FCM_SERVICE_ACCOUNT: string;
  RATE_LIMIT_PER_IP?: string; // requests/hour, default 1000 (env vars arrive as strings)
  RATE_LIMIT_PER_TOKEN?: string; // sends/hour,    default 60
  // Sender credential for /v1/send (phase 1: optional→mandatory — see PROTOCOL.md
  // "Sender credential"). Unset means this relay instance hasn't been provisioned
  // with the secret yet; every call is then treated as unauthenticated ("absent"),
  // never rejected. Set via `wrangler secret put SENDER_TOKEN`.
  SENDER_TOKEN?: string;
  // APNS_* (all optional) are declared in ApnsEnv — absent means ios tokens stay "unsupported".
}

const HOUR_MS = 3_600_000;
const BEARER_PREFIX = "Bearer ";
// Module-scope: isolate-local by design. See README §Rate limiting.
let ipLimiter: RateLimiter | null = null;
let tokenLimiter: RateLimiter | null = null;
let fcm: FcmClient | null = null;
let apns: ApnsClient | null | undefined; // undefined = not yet resolved; null = unconfigured

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
  if (apns === undefined) {
    const config = apnsConfigFromEnv(env);
    apns = config === null ? null : new ApnsClient(config);
  }

  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (!ipLimiter.tryAcquire(ip)) {
    return new Response(null, { status: 429, headers: { "retry-after": "3600" } });
  }

  // Sender credential check — runs before the body is ever parsed. Phase 1 (see
  // PROTOCOL.md): a present-but-wrong credential is rejected; an absent one still
  // proceeds (migration window) so existing self-hosted servers keep working while
  // they upgrade. Never logs the credential or any part of the request.
  if (checkSenderCredential(request, env.SENDER_TOKEN) === "invalid") {
    return Response.json({ error: "invalid sender credential" }, { status: 401 });
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
  const apnsClient = apns;
  const results: SendResponse["results"] = [];
  for (const t of v.value.tokens) {
    let status: Verdict;
    if (!tokenLimiter.tryAcquire(t.token)) status = "retryable";
    else if (t.platform === "ios") status = await sendIos(apnsClient, t.token, v.value.payload, v.value.collapseKey);
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

/** ApnsClient.send propagates transport throws (same contract as FcmClient) — map them here, without logging anything request-derived. */
async function sendIos(
  client: ApnsClient | null,
  token: string,
  payload: Record<string, unknown>,
  collapseKey?: string,
): Promise<Verdict> {
  if (client === null) return "unsupported"; // no APNs secrets configured on this deployment
  try {
    return await client.send(token, payload, collapseKey);
  } catch {
    return "retryable"; // transport failure reaching Apple — caller may retry
  }
}

export function intEnv(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? NaN : parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export type SenderCredentialVerdict = "valid" | "invalid" | "absent";

/**
 * Phase-1 (optional→mandatory) sender-credential check for `/v1/send` — see
 * PROTOCOL.md "Sender credential" for the two-phase rollout. Reads a bearer
 * token from `Authorization`, compared against [expectedToken] (the
 * `SENDER_TOKEN` wrangler secret) with a timing-safe equality check.
 *
 * [expectedToken] unset means this relay instance hasn't been provisioned with
 * the secret yet (or predates this check entirely) — every call is then
 * `"absent"`, never `"invalid"`, so deploying this code ahead of
 * `wrangler secret put SENDER_TOKEN` can never break an existing caller.
 */
export function checkSenderCredential(request: Request, expectedToken: string | undefined): SenderCredentialVerdict {
  if (!expectedToken) return "absent";

  const header = request.headers.get("authorization");
  if (header === null) return "absent"; // caller hasn't upgraded yet — migration window

  if (!header.startsWith(BEARER_PREFIX)) return "invalid";
  const provided = header.slice(BEARER_PREFIX.length);
  return timingSafeEqualStrings(provided, expectedToken) ? "valid" : "invalid";
}

/** Constant-time string comparison (via Workers' `crypto.subtle.timingSafeEqual`) so a wrong guess can't be narrowed by response-time measurement. */
function timingSafeEqualStrings(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}
