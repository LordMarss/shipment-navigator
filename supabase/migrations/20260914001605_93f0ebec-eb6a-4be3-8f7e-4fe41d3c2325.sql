CREATE TABLE public.shipment_notes (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  shipment_id uuid NOT NULL REFERENCES public.shipments(id) ON DELETE CASCADE,
  body text NOT NULL,
  author text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.shipment_notes TO anon, authenticated;
GRANT ALL ON public.shipment_notes TO service_role;

ALTER TABLE public.shipment_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Open access to shipment_notes" ON public.shipment_notes
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

CREATE INDEX shipment_notes_shipment_id_idx ON public.shipment_notes (shipment_id, created_at DESC);

CREATE TRIGGER shipment_notes_touch_updated_at
  BEFORE UPDATE ON public.shipment_notes
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();