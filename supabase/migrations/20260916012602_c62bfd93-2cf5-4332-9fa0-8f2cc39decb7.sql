-- Event-driven AIS automation trigger (Phase 4B).
--
-- NOT APPLIED to the live database as part of this phase — see the
-- deployment note at the bottom of this file. Committed here so the
-- mechanism is version-controlled and ready to activate once the
-- corresponding endpoint (src/routes/api/public/hooks/ais-position.ts) is
-- actually deployed and the Vault secret below is provisioned.
--
-- Mechanism: a Supabase Database Webhook, implemented directly via pg_net
-- (the same primitive Database Webhooks use under the hood) rather than the
-- generic `supabase_functions.http_request` trigger helper, because that
-- helper only accepts a static header literal — it cannot look up a secret
-- from Vault at execution time. Using pg_net directly, in a small trigger
-- function we own, lets the webhook secret live in Vault (encrypted at
-- rest, never in a committed file) while everything else about the request
-- (URL, payload shape, headers) matches what a dashboard-configured
-- Database Webhook would send.
--
-- Header naming: the secret is sent as `X-AIS-Webhook-Secret`, deliberately
-- not `Authorization`. As of this writing, Supabase Studio has an open bug
-- where an `Authorization` header configured on a Database Webhook is
-- silently stripped when the webhook is saved/re-saved in the dashboard
-- (github.com/supabase/supabase issues #38848, #39248). Since triggers
-- created here are managed by SQL/migrations rather than the dashboard
-- form, that specific bug may not even apply — but using a differently
-- named header avoids the risk entirely regardless of how this is ever
-- viewed or re-saved later.
--
-- Vault secret provisioning (REQUIRED before this trigger can succeed, and
-- deliberately NOT done here): run once, out of band, NEVER via a committed
-- migration or any other file that could reach git history:
--   select vault.create_secret('<the real AIS_WEBHOOK_SECRET value>', 'ais_webhook_secret');
-- The cleanest way to manage this going forward is Supabase CLI's
-- `[vault.secrets]` section in supabase/config.toml (which can reference an
-- env var via env(AIS_WEBHOOK_SECRET) and gets pushed automatically by
-- `supabase db push`, never storing the literal value in a file) — not used
-- here because supabase/config.toml is out of scope for this phase.

CREATE OR REPLACE FUNCTION public.notify_ais_position_webhook()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  webhook_secret text;
BEGIN
  SELECT decrypted_secret INTO webhook_secret
  FROM vault.decrypted_secrets
  WHERE name = 'ais_webhook_secret';

  IF webhook_secret IS NULL THEN
    -- Vault secret not yet provisioned — skip rather than fail the write
    -- that fired this trigger. pg_net calls are already fire-and-forget
    -- (async), so this is consistent with "never block the actual insert".
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url := 'https://shipment-navigator.vercel.app/api/public/hooks/ais-position',
    body := jsonb_build_object(
      'type', TG_OP,
      'table', TG_TABLE_NAME,
      'schema', TG_TABLE_SCHEMA,
      'record', to_jsonb(NEW),
      'old_record', CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END
    ),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-AIS-Webhook-Secret', webhook_secret
    ),
    timeout_milliseconds := 5000
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ais_position_webhook ON public.vessel_positions;
CREATE TRIGGER ais_position_webhook
  AFTER INSERT OR UPDATE ON public.vessel_positions
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_ais_position_webhook();

-- Deployment note: this migration is intentionally NOT pushed to the live
-- database in this phase. Applying it now would arm a live trigger against
-- a production URL that doesn't yet have this phase's endpoint deployed,
-- using a Vault secret that hasn't been provisioned yet — neither of which
-- serves any purpose before an actual deployment step. Apply with
-- `supabase db push` only once: (1) the endpoint is deployed, and (2) the
-- Vault secret has been provisioned as described above.
