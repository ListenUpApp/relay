import { defineConfig } from "vitest/config";

// Two isolates, two binding sets: `default` (APNs unconfigured — every ios
// token stays "unsupported", the pre-APNs deployment shape) and `apns`
// (APNs configured — test/send-apns.spec.ts exercises the real integration
// path against a stubbed api.push.apple.com). src/index.ts memoizes its
// ApnsClient/FcmClient/RateLimiters at module scope, so one isolate can only
// ever observe one binding set — hence two projects instead of one.
export default defineConfig({
  test: {
    projects: ["./vitest.config.default.ts", "./vitest.config.apns.ts"],
  },
});
