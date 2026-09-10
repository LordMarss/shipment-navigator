DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'shipment_status') THEN
    CREATE TYPE public.shipment_status AS ENUM ('Scheduled','Booked','Departed','In Transit','Approaching Destination','Arrived','At Port','Cleared Customs','Delivered');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.shipments (
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
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.documents (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  shipment_id uuid NOT NULL REFERENCES public.shipments(id) ON DELETE CASCADE,
  name text NOT NULL,
  done boolean NOT NULL DEFAULT false,
  is_standard boolean NOT NULL DEFAULT true,
  file_path text,
  file_url text,
  file_name text,
  file_type text,
  uploaded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.alerts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  shipment_id uuid REFERENCES public.shipments(id) ON DELETE CASCADE,
  message text NOT NULL,
  from_status public.shipment_status,
  to_status public.shipment_status,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.shipment_events (
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

CREATE TABLE IF NOT EXISTS public.app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS documents_shipment_id_idx ON public.documents(shipment_id);
CREATE INDEX IF NOT EXISTS alerts_created_at_idx ON public.alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS shipment_events_shipment_idx ON public.shipment_events (shipment_id, occurred_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.shipments TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.documents TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.alerts TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shipment_events TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_settings TO anon, authenticated;
GRANT ALL ON public.shipments, public.documents, public.alerts, public.shipment_events, public.app_settings TO service_role;

ALTER TABLE public.shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shipment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Open access to shipments" ON public.shipments FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "Open access to documents" ON public.documents FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "Open access to alerts" ON public.alerts FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "Open access to shipment_events" ON public.shipment_events FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "Open access to app_settings" ON public.app_settings FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS shipments_touch_updated_at ON public.shipments;
CREATE TRIGGER shipments_touch_updated_at BEFORE UPDATE ON public.shipments
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
DROP TRIGGER IF EXISTS app_settings_touch_updated_at ON public.app_settings;
CREATE TRIGGER app_settings_touch_updated_at BEFORE UPDATE ON public.app_settings
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

INSERT INTO public.app_settings (key, value) VALUES
  ('monitoring_start_offset_days', '7'::jsonb),
  ('pre_monitoring_window_days', '3'::jsonb),
  ('eta_attention_hours', '6'::jsonb),
  ('eta_risk_hours', '24'::jsonb)
ON CONFLICT (key) DO NOTHING;