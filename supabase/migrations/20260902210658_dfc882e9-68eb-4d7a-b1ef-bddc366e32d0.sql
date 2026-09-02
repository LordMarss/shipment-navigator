-- Extend the status lifecycle (existing values preserved)
ALTER TYPE public.shipment_status ADD VALUE IF NOT EXISTS 'Scheduled' BEFORE 'Booked';
ALTER TYPE public.shipment_status ADD VALUE IF NOT EXISTS 'Departed' AFTER 'Booked';
ALTER TYPE public.shipment_status ADD VALUE IF NOT EXISTS 'Approaching Destination' AFTER 'In Transit';
ALTER TYPE public.shipment_status ADD VALUE IF NOT EXISTS 'Arrived' AFTER 'Approaching Destination';

-- Temporal structure
ALTER TABLE public.shipments
  ADD COLUMN IF NOT EXISTS planned_etd timestamp with time zone,
  ADD COLUMN IF NOT EXISTS planned_eta timestamp with time zone,
  ADD COLUMN IF NOT EXISTS actual_departure timestamp with time zone,
  ADD COLUMN IF NOT EXISTS actual_arrival timestamp with time zone,
  ADD COLUMN IF NOT EXISTS actual_delivery timestamp with time zone,
  ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_synced_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS health text NOT NULL DEFAULT 'On Track',
  ADD COLUMN IF NOT EXISTS health_reason text,
  ADD COLUMN IF NOT EXISTS monitoring_state text NOT NULL DEFAULT 'Scheduled',
  ADD COLUMN IF NOT EXISTS monitoring_start_offset_days integer,
  ADD COLUMN IF NOT EXISTS reference text,
  ADD COLUMN IF NOT EXISTS carrier text,
  ADD COLUMN IF NOT EXISTS container_number text,
  ADD COLUMN IF NOT EXISTS customer_reference text,
  ADD COLUMN IF NOT EXISTS vessel_imo text;

-- Backfill planned arrival from the existing ETA so no data is lost
UPDATE public.shipments SET planned_eta = COALESCE(planned_eta, previous_eta, eta);

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS shipments_touch_updated_at ON public.shipments;
CREATE TRIGGER shipments_touch_updated_at
  BEFORE UPDATE ON public.shipments
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Lifecycle timeline + audit trail
CREATE TABLE IF NOT EXISTS public.shipment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL REFERENCES public.shipments(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  category text NOT NULL DEFAULT 'event',
  occurred_at timestamp with time zone NOT NULL DEFAULT now(),
  field text,
  from_value text,
  to_value text,
  source text NOT NULL DEFAULT 'manual',
  automated boolean NOT NULL DEFAULT false,
  actor text,
  reason text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.shipment_events TO anon, authenticated;
GRANT ALL ON public.shipment_events TO service_role;
ALTER TABLE public.shipment_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Open access to shipment_events" ON public.shipment_events
  FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS shipment_events_shipment_idx
  ON public.shipment_events (shipment_id, occurred_at DESC);

-- Configurable workspace settings (no hard-coded monitoring offsets)
CREATE TABLE IF NOT EXISTS public.app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_settings TO anon, authenticated;
GRANT ALL ON public.app_settings TO service_role;
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Open access to app_settings" ON public.app_settings
  FOR ALL USING (true) WITH CHECK (true);

DROP TRIGGER IF EXISTS app_settings_touch_updated_at ON public.app_settings;
CREATE TRIGGER app_settings_touch_updated_at
  BEFORE UPDATE ON public.app_settings
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

INSERT INTO public.app_settings (key, value) VALUES
  ('monitoring_start_offset_days', '7'::jsonb),
  ('pre_monitoring_window_days', '3'::jsonb),
  ('eta_attention_hours', '6'::jsonb),
  ('eta_risk_hours', '24'::jsonb)
ON CONFLICT (key) DO NOTHING;