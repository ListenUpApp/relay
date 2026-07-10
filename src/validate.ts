import {
  MAX_COLLAPSE_KEY_LENGTH, MAX_PAYLOAD_BYTES, MAX_TOKENS, MAX_TOKEN_LENGTH,
  type DeviceToken, type SendRequest,
} from "./types";

export type Validation =
  | { ok: true; value: SendRequest }
  | { ok: false; status: 400 | 413; message: string };

const bad = (message: string, status: 400 | 413 = 400): Validation => ({ ok: false, status, message });

export function validateSendRequest(body: unknown): Validation {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return bad("body must be an object");
  const b = body as Record<string, unknown>;

  if (!Array.isArray(b.tokens) || b.tokens.length === 0) return bad("tokens must be a non-empty array");
  if (b.tokens.length > MAX_TOKENS) return bad(`tokens capped at ${MAX_TOKENS}`);
  const tokens: DeviceToken[] = [];
  for (const t of b.tokens) {
    if (typeof t !== "object" || t === null) return bad("token entries must be objects");
    const { platform, token } = t as Record<string, unknown>;
    if (platform !== "android" && platform !== "ios") return bad("platform must be android|ios");
    if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return bad("bad token");
    tokens.push({ platform, token });
  }

  if (typeof b.payload !== "object" || b.payload === null || Array.isArray(b.payload)) return bad("payload must be an object");
  if (new TextEncoder().encode(JSON.stringify(b.payload)).length > MAX_PAYLOAD_BYTES) {
    return bad(`payload capped at ${MAX_PAYLOAD_BYTES} bytes`, 413);
  }

  let collapseKey: string | undefined;
  if (b.collapseKey !== undefined) {
    if (typeof b.collapseKey !== "string" || b.collapseKey.length > MAX_COLLAPSE_KEY_LENGTH) return bad("bad collapseKey");
    collapseKey = b.collapseKey;
  }

  return { ok: true, value: { tokens, payload: b.payload as Record<string, unknown>, collapseKey } };
}
