import { createFileRoute } from "@tanstack/react-router";

import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";

/**
 * Scheduled automation endpoint. Called by the database scheduler roughly every
 * 15 minutes; runs independently of any open browser. Requires the cron secret.
 */
async function handle(request: Request) {
  const denied = await authenticateCronRequest(request);
  if (denied) return denied;

  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { runAutomationSweep } = await import("@/lib/automation.server");
    const result = await runAutomationSweep(supabaseAdmin);
    console.log("[automation] sweep complete", result);
    return Response.json({ ok: true, ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[automation] sweep failed:", message);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}

export const Route = createFileRoute("/api/public/hooks/automation-run")({
  server: {
    handlers: {
      POST: ({ request }) => handle(request),
      GET: ({ request }) => handle(request),
    },
  },
});
