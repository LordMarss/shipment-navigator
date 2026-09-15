-- Latest known AIS position per vessel (one row per MMSI, upserted on every
-- message). Deliberately not a raw-message log: AISStream can emit several
-- position reports per minute per vessel, and Phase 1 only needs "where is
-- this vessel right now", not an unbounded history table.
CREATE TABLE IF NOT EXISTS public.vessel_positions (
  mmsi text PRIMARY KEY,
  vessel_name text,
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  sog numeric,
  cog numeric,
  true_heading integer,
  nav_status text,
  position_timestamp timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'aisstream',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vessel_positions_updated_at_idx ON public.vessel_positions (updated_at DESC);

-- Read is safe to open up (matches the rest of the schema's open-access
-- pattern for future UI use); writes are server-only — only the ingestion
-- worker (service role) should ever set a vessel's position.
GRANT SELECT ON public.vessel_positions TO anon, authenticated;
GRANT ALL ON public.vessel_positions TO service_role;

ALTER TABLE public.vessel_positions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Public read access to vessel_positions" ON public.vessel_positions
    FOR SELECT TO anon, authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DROP TRIGGER IF EXISTS vessel_positions_touch_updated_at ON public.vessel_positions;
CREATE TRIGGER vessel_positions_touch_updated_at BEFORE UPDATE ON public.vessel_positions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
