import type { Verdict } from "./types";

/**
 * APNs forwarding is NOT implemented yet. iOS tokens get "unsupported" so
 * callers keep the token and skip retries. The real module lands with the
 * ListenUp iOS leg: token-based .p8 JWT auth over HTTP/2 to api.push.apple.com.
 * See PROTOCOL.md §Verdicts.
 */
export function sendApns(): Verdict {
  return "unsupported";
}
