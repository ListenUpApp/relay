# listenup-relay

A small, no-log push relay for self-hosted apps, built as a Cloudflare
Worker.

Store-distributed apps (App Store, Play Store) can't ship push credentials
to people who self-host the backend — a Firebase service-account key or an
APNs `.p8` signing key has to live somewhere the app's operator controls,
and a self-hoster's home server isn't a place you want to hand those to.
This relay is the fix: it holds the push credentials centrally, and
self-hosted servers call it with nothing more than a device token and an
opaque payload. It never sees, stores, or logs anything else about your
users.

[ListenUp](https://listenup.audio) is the first consumer of this relay, but
nothing here is ListenUp-specific — the protocol (see
[PROTOCOL.md](./PROTOCOL.md)) is generic, and the code is MIT-licensed. If
you're building a self-hosted app with the same store-distribution problem,
deploy your own instance.

## Deploy your own

1. Create a Firebase project for **your** app, with Cloud Messaging
   enabled, and generate a service-account key (Project settings → Service
   accounts → Generate new private key). Keep the downloaded JSON safe —
   it's the only secret this relay needs.
2. Install dependencies and set the secret:

   ```sh
   npm i
   npx wrangler login
   npx wrangler secret put FCM_SERVICE_ACCOUNT
   # paste the full service-account JSON when prompted
   ```

3. Deploy:

   ```sh
   npm run deploy
   ```

4. Attach a custom domain (Cloudflare dashboard → your Worker → Settings →
   Domains & Routes, or configure `routes` in `wrangler.jsonc` at deploy
   time). Point your self-hosted app's push config at that domain.
5. **Recommended:** add a Cloudflare WAF rate rule in front of the Worker as
   a hard rate-limit backstop — see [Rate limiting](#rate-limiting) below
   for why the in-Worker limiter alone isn't sufficient defense-in-depth.

That's it — no database, no KV namespace, no other bindings. The relay is
stateless across requests beyond ephemeral in-memory rate-limit counters.

## The no-log invariant

This relay's entire value proposition is that self-hosters can trust it
with their users' push tokens. Concretely:

- Device tokens are **never** logged or persisted.
- Payload contents are **never** logged or persisted, and never
  interpreted — they're forwarded to the push provider as an opaque blob.
- Request metadata (IP, headers, etc.) is used only transiently to compute
  an in-memory rate-limit key for the current process; none of it is
  written anywhere.
- The **only** state this Worker keeps is two in-memory sliding-window
  rate-limit counters (per-IP, per-token), scoped to a single isolate and
  gone the moment it recycles.

This is pinned by test — `test/send.spec.ts` spies on `console.log/warn/
error/info/debug` across a real send and asserts none of them ever contain
the request's token or payload contents.

## Rate limiting

Two independent in-memory sliding-window limiters run inside the Worker:

- **Per-IP**: default 1000 requests/hour, tunable via the `RATE_LIMIT_PER_IP`
  env var. Exceeding it returns `429` with `Retry-After` for the whole
  request, before the body is even parsed.
- **Per-token**: default 60 sends/hour, tunable via `RATE_LIMIT_PER_TOKEN`.
  Exceeding it doesn't fail the request — it yields a `"retryable"` verdict
  for just that token (see [PROTOCOL.md](./PROTOCOL.md#verdict-semantics)).

Both limiters are **isolate-local and best-effort**, not a global guarantee:
Cloudflare can and will run multiple isolates of the same Worker
concurrently, each with its own counters, so the effective limit under load
can exceed the configured number. Treat these as a courtesy backstop against
accidental client bugs, not a security control. For an actual hard limit,
put a [Cloudflare WAF rate
rule](https://developers.cloudflare.com/waf/rate-limiting-rules/) in front
of the Worker.

One CPU-time note if you're tuning limits: `RateLimiter.prune()` runs once
per request per limiter and is `O(active keys)` — with very high token
cardinality and a long window, pruning cost grows with how many distinct
keys are live. The defaults above are sized to keep this cheap; if you
raise the windows or the limits substantially, keep an eye on Worker CPU
time.

## Development

```sh
npm test        # vitest, runs against workerd via @cloudflare/vitest-pool-workers
npm run typecheck
npm run dev      # local dev server via wrangler
```

## Protocol

The wire protocol — request/response shapes, caps, HTTP statuses, verdict
semantics, and the FCM mapping — is specified in
[PROTOCOL.md](./PROTOCOL.md). Read it if you're implementing a client, or
an alternative relay implementation.

## License

MIT — see [LICENSE](./LICENSE).
