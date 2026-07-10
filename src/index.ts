export interface Env {
  FCM_SERVICE_ACCOUNT: string; // JSON of the Google service account, via wrangler secret
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return Response.json({ ok: true });
    }
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
