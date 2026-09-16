import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { authenticateAisWebhookRequest } from "@/lib/aisWebhookAuth";

/**
 * Supabase Database Webhook target for `public.vessel_positions`
 * (INSERT/UPDATE). Standard Supabase webhook payload shape:
 *   { type: "INSERT" | "UPDATE" | "DELETE", table, schema, record, old_record }
 * We only act on rows carrying an mmsi (present in `record` for
 * INSERT/UPDATE, or `old_record` for the DELETE case, which the configured
 * trigger doesn't fire for but this stays defensive rather than assuming).
 */
const webhookPayloadSchema = z.object({
  type: z.enum(["INSERT", "UPDATE", "DELETE"]),
  table: z.string().optional(),
  schema: z.string().optional(),
  record: z.object({ mmsi: z.union([z.string(), z.number()]) }).passthrough().nullable().optional(),
  old_record: z.object({ mmsi: z.union([z.string(), z.number()]) }).passthrough().nullable().optional(),
});

type EvaluateFn = (mmsi: string) => Promise<{ evaluated: number; updated: number }>;

async function defaultEvaluate(mmsi: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { evaluateAisPositionForMmsi } = await import("@/lib/aisWebhook.server");
  return evaluateAisPositionForMmsi(mmsi, supabaseAdmin);
}

/**
 * Exported (with an injectable `evaluate`) so auth/payload-validation
 * behavior can be unit tested directly, without needing to mock the
 * dynamic Supabase imports used in production. Business-logic integration
 * (shipment matching, automation evaluation) is tested separately, directly
 * against `evaluateAisPositionForMmsi` in aisWebhook.server.ts.
 */
export async function handleAisPositionWebhook(
  request: Request,
  evaluate: EvaluateFn = defaultEvaluate,
): Promise<Response> {
  const denied = await authenticateAisWebhookRequest(request);
  if (denied) return denied;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return Response.json({ ok: false, error: "Malformed JSON body" }, { status: 400 });
  }

  const parsed = webhookPayloadSchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json({ ok: false, error: "Invalid webhook payload" }, { status: 400 });
  }

  const mmsiValue = parsed.data.record?.mmsi ?? parsed.data.old_record?.mmsi;
  if (mmsiValue == null) {
    return Response.json({ ok: false, error: "Payload missing mmsi" }, { status: 400 });
  }
  const mmsi = String(mmsiValue);

  try {
    const result = await evaluate(mmsi);
    console.log(`[ais-webhook] evaluated MMSI ${mmsi}:`, result);
    return Response.json({ ok: true, mmsi, ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[ais-webhook] evaluation failed for MMSI ${mmsi}:`, message);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}

export const Route = createFileRoute("/api/public/hooks/ais-position")({
  server: {
    handlers: {
      POST: ({ request }) => handleAisPositionWebhook(request),
    },
  },
});
