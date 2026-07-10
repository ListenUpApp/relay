export async function makeTestServiceAccount(): Promise<{ json: string; publicKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
  const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
  const json = JSON.stringify({
    type: "service_account",
    project_id: "test-project",
    private_key: pem,
    client_email: "relay-test@test-project.iam.gserviceaccount.com",
    token_uri: "https://oauth2.googleapis.com/token",
  });
  return { json, publicKey: pair.publicKey };
}

export interface RecordedRequest {
  url: string;
  method: string;
  body: string | null;
}

/** Scripted fetch fake: dequeues responses in order, records every request. */
export function fakeFetch(responses: Array<Response | Error>) {
  const requests: RecordedRequest[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    requests.push({ url: req.url, method: req.method, body: init?.body != null ? String(init.body) : null });
    const next = responses.shift();
    if (next === undefined) throw new Error(`fakeFetch: unexpected request to ${req.url}`);
    if (next instanceof Error) throw next;
    return next.clone();
  }) as typeof fetch;
  return { fn, requests };
}

export const tokenResponse = (token = "at", expiresIn = 3600) =>
  new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }), { status: 200 });
