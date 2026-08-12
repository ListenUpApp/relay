import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { makeTestApnsKey } from "./test/helpers";

/**
 * Generates a throwaway RSA service-account fixture for FcmClient. handleSend
 * constructs an FcmClient unconditionally (even for an all-ios request), so
 * this isolate needs a valid FCM_SERVICE_ACCOUNT binding too, even though
 * this project's specs never exercise the FCM path.
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

// The "apns" project: a dedicated isolate with APNS_* configured, so
// apnsConfigFromEnv resolves a real ApnsConfig and /v1/send's sendIos()
// actually drives ApnsClient against a stubbed api.push.apple.com. Isolated
// from vitest.config.default.ts's isolate (where APNs stays unconfigured)
// because src/index.ts memoizes the ApnsClient at module scope per isolate.
export default defineConfig({
  test: {
    name: "apns",
    include: ["test/send-apns.spec.ts"],
  },
  plugins: [
    cloudflareTest(async () => {
      const { pem } = await makeTestApnsKey();
      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            FCM_SERVICE_ACCOUNT: await makeTestServiceAccount(),
            RATE_LIMIT_PER_IP: "5",
            RATE_LIMIT_PER_TOKEN: "2",
            APNS_KEY: pem,
            APNS_KEY_ID: "TESTKEYID1",
            APNS_TEAM_ID: "TESTTEAMID",
            APNS_BUNDLE_ID: "audio.listenup.app",
          },
        },
      };
    }),
  ],
});
