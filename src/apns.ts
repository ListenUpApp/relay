import type { Verdict } from "./types";

/** APNs provider configuration, assembled from env by `apnsConfigFromEnv`. */
export interface ApnsConfig {
  /** PKCS8 PEM of the `.p8` provider auth key (ES256, P-256). */
  key: string;
  /** 10-character key id shown next to the key in the developer portal. */
  keyId: string;
  /** 10-character Apple Developer team id. */
  teamId: string;
  /** The app's bundle id — sent as `apns-topic`. */
  bundleId: string;
  /** `"production"` (default) or `"development"` (sandbox device tokens). */
  environment: "production" | "development";
  /**
   * `title-loc-key` / `loc-key` placed in the alert envelope. Constants naming
   * strings in the APP's bundle — the relay still composes no UI text; if the
   * app's notification service extension never runs, iOS itself renders these
   * localized fallbacks.
   */
  titleLocKey: string;
  bodyLocKey: string;
}

/** Env slice the APNs path reads (all optional — absent means iOS is unsupported). */
export interface ApnsEnv {
  APNS_KEY?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_BUNDLE_ID?: string;
  APNS_ENVIRONMENT?: string;
  APNS_TITLE_LOC_KEY?: string;
  APNS_BODY_LOC_KEY?: string;
}

/**
 * Builds an [ApnsConfig] from env, or `null` when the APNs secrets aren't
 * configured — in which case every `ios` token keeps the pre-APNs
 * `"unsupported"` verdict, exactly as before this module existed.
 */
export function apnsConfigFromEnv(env: ApnsEnv): ApnsConfig | null {
  if (!env.APNS_KEY || !env.APNS_KEY_ID || !env.APNS_TEAM_ID || !env.APNS_BUNDLE_ID) return null;
  return {
    key: env.APNS_KEY,
    keyId: env.APNS_KEY_ID,
    teamId: env.APNS_TEAM_ID,
    bundleId: env.APNS_BUNDLE_ID,
    environment: env.APNS_ENVIRONMENT === "development" ? "development" : "production",
    titleLocKey: env.APNS_TITLE_LOC_KEY ?? "push.generic_title",
    bodyLocKey: env.APNS_BODY_LOC_KEY ?? "push.generic_body",
  };
}

const b64url = (data: ArrayBuffer | string): string => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

function pemToPkcs8(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const raw = atob(b64);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf.buffer;
}

/**
 * How long a minted provider token is reused before signing a fresh one.
 * Apple requires provider tokens be refreshed at most every 60 minutes and
 * no more often than every 20; 45 sits safely inside that window.
 */
const TOKEN_TTL_MS = 45 * 60_000;

/**
 * APNs client: signs ES256 provider tokens from the configured `.p8` key and
 * sends `alert` pushes with a localized generic envelope plus the caller's
 * opaque payload (the app's service extension enriches locally; see
 * PROTOCOL.md § APNs mapping).
 *
 * Tokens are cached isolate-locally for [TOKEN_TTL_MS] — ephemeral, never
 * persisted. Mirrors `FcmClient`'s contract: token-mint failures normalize to
 * `"retryable"`, transport failures on the send itself propagate to the
 * caller (the /v1/send handler maps them, without logging request data).
 */
export class ApnsClient {
  private readonly config: ApnsConfig;
  private readonly fetchFn: typeof fetch;
  private cached: { token: string; expiresAt: number } | null = null;

  // Arrow wrapper for the same reason as FcmClient: a bare `fetch` reference invoked as
  // `this.fetchFn(...)` re-binds `this` and workerd throws a synchronous "Illegal invocation".
  constructor(config: ApnsConfig, fetchFn: typeof fetch = (input, init) => fetch(input, init)) {
    this.config = config;
    this.fetchFn = fetchFn;
  }

  get host(): string {
    return this.config.environment === "development"
      ? "https://api.sandbox.push.apple.com"
      : "https://api.push.apple.com";
  }

  /** Returns a signed provider token, minting a fresh one when the cached one ages out. */
  async providerToken(): Promise<string> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt > now) return this.cached.token;

    const key = await crypto.subtle.importKey(
      "pkcs8",
      pemToPkcs8(this.config.key),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    const header = b64url(JSON.stringify({ alg: "ES256", kid: this.config.keyId }));
    const claims = b64url(JSON.stringify({ iss: this.config.teamId, iat: Math.floor(now / 1000) }));
    // WebCrypto ECDSA signatures are raw r||s — exactly the JOSE ES256 format, no DER unwrapping.
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      new TextEncoder().encode(`${header}.${claims}`),
    );
    const token = `${header}.${claims}.${b64url(signature)}`;
    this.cached = { token, expiresAt: now + TOKEN_TTL_MS };
    return token;
  }

  /**
   * Sends one `alert` push. The `aps` envelope carries only constant loc-keys
   * (localized by the app bundle) and `mutable-content: 1` so the app's
   * service extension can decode the custom `payload` key and rewrite the
   * content; if the extension never runs, iOS renders the generic fallback.
   */
  async send(token: string, payload: Record<string, unknown>, collapseKey?: string): Promise<Verdict> {
    let providerToken: string;
    try {
      providerToken = await this.providerToken();
    } catch {
      return "retryable"; // auth infra hiccup: caller may retry the whole send
    }
    const headers: Record<string, string> = {
      authorization: `bearer ${providerToken}`,
      "apns-topic": this.config.bundleId,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    };
    if (collapseKey !== undefined) headers["apns-collapse-id"] = collapseKey;
    const res = await this.fetchFn(`${this.host}/3/device/${token}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        aps: {
          alert: { "title-loc-key": this.config.titleLocKey, "loc-key": this.config.bodyLocKey },
          "mutable-content": 1,
        },
        payload: JSON.stringify(payload),
      }),
    });
    if (res.ok) return "delivered";
    // 403 is our provider token (InvalidProviderToken/ExpiredProviderToken) — never the device
    // token's fault; drop the cache so the next send re-signs instead of riding out the TTL.
    if (res.status === 403) {
      this.cached = null;
      return "retryable";
    }
    if (res.status === 429 || res.status >= 500) return "retryable";
    return "invalid"; // 400 (BadDeviceToken et al.), 404, 410 (Unregistered): the token is dead
  }
}
