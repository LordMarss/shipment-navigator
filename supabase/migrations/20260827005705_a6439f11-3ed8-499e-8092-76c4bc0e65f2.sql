CREATE TYPE public.shipment_status AS ENUM ('Booked', 'In Transit', 'At Port', 'Cleared Customs', 'Delivered');

CREATE TABLE public.shipments (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  client_name text NOT NULL,
  origin text NOT NULL,
  destination text NOT NULL,
  vessel_name text,
  vessel_mmsi text,
  landed_cost numeric,
  status public.shipment_status NOT NULL DEFAULT 'Booked',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.documents (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  shipment_id uuid NOT NULL REFERENCES public.shipments(id) ON DELETE CASCADE,
  name text NOT NULL,
  done boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.alerts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  shipment_id uuid REFERENCES public.shipments(id) ON DELETE CASCADE,
  message text NOT NULL,
  from_status public.shipment_status,
  to_status public.shipment_status,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX documents_shipment_id_idx ON public.documents(shipment_id);
CREATE INDEX alerts_created_at_idx ON public.alerts(created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.shipments TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.documents TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.alerts TO anon, authenticated;
GRANT ALL ON public.shipments TO service_role;
GRANT ALL ON public.documents TO service_role;
GRANT ALL ON public.alerts TO service_role;

ALTER TABLE public.shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Open access to shipments" ON public.shipments FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Open access to documents" ON public.documents FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Open access to alerts" ON public.alerts FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);