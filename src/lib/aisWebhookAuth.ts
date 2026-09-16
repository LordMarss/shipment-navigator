/**
 * Server-to-server auth for the AIS position webhook endpoint
 * (src/routes/api/public/hooks/ais-position.ts). Mirrors the existing
 * cron-auth.ts constant-time comparison pattern (same secret-vs-header
 * check, same hash-then-compare approach), but:
 *
 *  - reads AIS_WEBHOOK_SECRET, a dedicated secret — never the AISStream
 *    API key, never CRON_SECRET.
 *  - checks a custom `X-AIS-Webhook-Secret` header instead of an
 *    `Authorization: Bearer` token, deliberately avoiding the header name
 *    "Authorization". As of this writing, Supabase's own Studio has an open
 *    bug where an "Authorization" header configured on a Database Webhook
 *    is silently stripped when the webhook is saved/re-saved
 *    (github.com/supabase/supabase issues #38848, #39248). Since this
 *    endpoint exists specifically to receive Supabase Database Webhook
 *    calls, using a differently-named header sidesteps that bug entirely
 *    rather than depending on nobody ever re-saving it in the dashboard.
 */
export async function authenticateAisWebhookRequest(request: Request): Promise<Response | null> {
  const secret = process.env["AIS_WEBHOOK_SECRET"];
  if (!secret) {
    return new Response("Server configuration error", { status: 500 });
  }

  const provided = request.headers.get("x-ais-webhook-secret");
  if (!provided) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { createHash, timingSafeEqual } = await import("node:crypto");
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

  if (!timingSafeEqual(digest(provided), digest(secret))) {
    return new Response("Unauthorized", { status: 401 });
  }

  return null;
}
