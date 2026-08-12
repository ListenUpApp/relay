import { defineConfig, configDefaults } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

/**
 * Generates a throwaway RSA service-account fixture for FcmClient tests, using
 * Node's WebCrypto (this file runs in the Node/Vite process, not workerd — but
 * RSASSA-PKCS1-v1_5 + PKCS8 PEM are standard, interoperable formats, so a key
 * minted here imports fine inside the worker under test).
 */
async function makeTestServiceAccount(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
  const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
  return JSON.stringify({
    type: "service_account",
    project_id: "test-project",
    private_key: pem,
    client_email: "relay-test@test-project.iam.gserviceaccount.com",
    token_uri: "https://oauth2.googleapis.com/token",
  });
}

// The "default" project: APNs is UNCONFIGURED here (no APNS_* bindings), so
// apnsConfigFromEnv resolves null and every ios token stays "unsupported" —
// exactly the pre-APNs deployment shape. test/send-apns.spec.ts needs the
// OPPOSITE (APNs configured); since src/index.ts memoizes its clients at
// module scope, one isolate can only ever see one binding set, so that spec
// runs under its own project (vitest.config.apns.ts) with its own isolate.
export default defineConfig({
  test: {
    name: "default",
    exclude: [...configDefaults.exclude, "test/send-apns.spec.ts"],
  },
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          FCM_SERVICE_ACCOUNT: await makeTestServiceAccount(),
          // Small, fixed caps so /v1/send rate-limit tests run fast and deterministically.
          // See test/send.spec.ts for why each test uses a dedicated IP/token namespace.
          RATE_LIMIT_PER_IP: "5",
          RATE_LIMIT_PER_TOKEN: "2",
          // Fixed test value for the sender-credential check (test/auth.spec.ts). Existing
          // send.spec.ts tests never send an Authorization header, so they stay "absent" and
          // unaffected — this only activates for tests that explicitly send the header.
          SENDER_TOKEN: "test-sender-secret",
        },
      },
    })),
  ],
});
