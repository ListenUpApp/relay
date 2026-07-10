interface ServiceAccount {
  project_id: string;
  private_key: string;
  client_email: string;
  token_uri: string;
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
 * Exchanges a Google service-account key for an FCM OAuth access token.
 * Signs an RS256 JWT with WebCrypto and trades it for an access token at
 * the account's token_uri, caching the result for the token's lifetime
 * (isolate-local, ephemeral — never persisted).
 */
export class FcmClient {
  private readonly account: ServiceAccount;
  private readonly fetchFn: typeof fetch;
  private cached: { token: string; expiresAt: number } | null = null;

  constructor(serviceAccountJson: string, fetchFn: typeof fetch = fetch) {
    this.account = JSON.parse(serviceAccountJson) as ServiceAccount;
    this.fetchFn = fetchFn;
  }

  get projectId(): string {
    return this.account.project_id;
  }

  async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt - 60_000 > now) return this.cached.token;

    const key = await crypto.subtle.importKey(
      "pkcs8",
      pemToPkcs8(this.account.private_key),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const iat = Math.floor(now / 1000);
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(
      JSON.stringify({
        iss: this.account.client_email,
        scope: "https://www.googleapis.com/auth/firebase.messaging",
        aud: this.account.token_uri,
        iat,
        exp: iat + 3600,
      }),
    );
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(`${header}.${claims}`),
    );
    const assertion = `${header}.${claims}.${b64url(signature)}`;

    const res = await this.fetchFn(this.account.token_uri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
    if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.cached = { token: body.access_token, expiresAt: now + body.expires_in * 1000 };
    return body.access_token;
  }
}
