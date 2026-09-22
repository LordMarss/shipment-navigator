/**
 * The minimum slice of the production schema that the Phase 2 transition
 * functions touch, as it stands BEFORE 20260923000000_atomic_shipment_transitions.sql.
 * Used by the database-level tests (embedded Postgres) so the real migration
 * file can be applied and exercised without a Supabase project.
 *
 * Mirrors the real DDL (see supabase/migrations 20260827…, 20260902…, 20260910…,
 * 20260916003036…, 20260917215707…); the enum's value ORDER matches production
 * (values were added with BEFORE/AFTER, ending up lifecycle-ordered, legacy last).
 * If a production column these functions rely on is renamed, the migration
 * fails against this schema — which is the point.
 */
export const BASE_SCHEMA_SQL = `
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TYPE public.shipment_status AS ENUM (
  'Scheduled','Booked','Departed','In Transit','Approaching Destination','Arrived',
  'At Port','Cleared Customs','Delivered'
);

CREATE OR REPLACE FUNCTION public.touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TABLE public.shipments (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  client_name text NOT NULL,
  origin text NOT NULL,
  destination text NOT NULL,
  vessel_name text,
  vessel_mmsi text,
  vessel_imo text,
  landed_cost numeric,
  status public.shipment_status NOT NULL DEFAULT 'Booked',
  eta timestamptz,
  previous_eta timestamptz,
  planned_etd timestamptz,
  planned_eta timestamptz,
  actual_departure timestamptz,
  actual_arrival timestamptz,
  actual_delivery timestamptz,
  health text NOT NULL DEFAULT 'On Track',
  health_reason text,
  monitoring_state text NOT NULL DEFAULT 'Scheduled',
  monitoring_start_offset_days integer,
  reference text,
  carrier text,
  container_number text,
  customer_reference text,
  last_synced_at timestamptz,
  ais_pending_status public.shipment_status,
  ais_pending_since timestamptz,
  origin_port_id uuid,
  destination_port_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER shipments_touch_updated_at BEFORE UPDATE ON public.shipments
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.alerts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  shipment_id uuid REFERENCES public.shipments(id) ON DELETE CASCADE,
  message text NOT NULL,
  from_status public.shipment_status,
  to_status public.shipment_status,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.shipment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL REFERENCES public.shipments(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  category text NOT NULL DEFAULT 'event',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  field text,
  from_value text,
  to_value text,
  source text NOT NULL DEFAULT 'manual',
  automated boolean NOT NULL DEFAULT false,
  actor text,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Production access model: the API roles hold full table privileges and every
-- table carries an "open access" RLS policy; new functions in the public schema
-- are granted EXECUTE to the API roles by default (Supabase default privileges).
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER TABLE public.shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shipment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Open access to shipments" ON public.shipments FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Open access to alerts" ON public.alerts FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Open access to shipment_events" ON public.shipment_events FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Open access to app_settings" ON public.app_settings FOR ALL USING (true) WITH CHECK (true);

INSERT INTO public.app_settings (key, value) VALUES
  ('monitoring_start_offset_days', '2'::jsonb),
  ('pre_monitoring_window_days', '3'::jsonb),
  ('eta_attention_hours', '6'::jsonb),
  ('eta_risk_hours', '24'::jsonb);
`;
