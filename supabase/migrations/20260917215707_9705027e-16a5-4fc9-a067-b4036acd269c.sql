-- Structured port reference data for destination-aware AIS arrival
-- detection (Phase: destination geofencing).
--
-- Coordinates are the port/harbor area (not berth-level) and are accurate
-- enough for a ~20km MVP geofence, not a survey-grade dataset. UN/LOCODE is
-- populated only where confidently known; it is intentionally left NULL
-- rather than guessed for the remainder — a NULL unlocode never collides
-- with the UNIQUE constraint (Postgres treats each NULL as distinct).
-- Source: general public port/UN-LOCODE reference knowledge, compiled for
-- this MVP seed. Treat as a starting point — validate against the official
-- UNECE UN/LOCODE dataset before relying on this for anything beyond a
-- coarse geofence, and refine coordinates/add berths as real needs arise.
CREATE TABLE IF NOT EXISTS public.ports (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL,
  unlocode text UNIQUE,
  country text,
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  geofence_radius_km double precision NOT NULL DEFAULT 20,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ports_name_idx ON public.ports (name);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ports TO anon, authenticated;
GRANT ALL ON public.ports TO service_role;

ALTER TABLE public.ports ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Open access to ports" ON public.ports FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- MVP seed: major ocean container/trade ports across the main global trade
-- lanes, sufficient to exercise destination-aware arrival detection without
-- requiring users to enter coordinates manually. `ON CONFLICT DO NOTHING`
-- keyed on unlocode makes this safe to re-run; the handful of NULL-unlocode
-- rows are keyed by name instead via the second statement below.
INSERT INTO public.ports (name, unlocode, country, latitude, longitude, geofence_radius_km) VALUES
  ('Shanghai', 'CNSHA', 'China', 31.22, 121.49, 25),
  ('Ningbo-Zhoushan', 'CNNGB', 'China', 29.87, 121.87, 25),
  ('Shenzhen', 'CNSZX', 'China', 22.54, 114.05, 20),
  ('Guangzhou', 'CNCAN', 'China', 23.09, 113.46, 20),
  ('Qingdao', 'CNTAO', 'China', 36.07, 120.33, 20),
  ('Tianjin', 'CNTXG', 'China', 38.98, 117.72, 20),
  ('Hong Kong', 'HKHKG', 'Hong Kong', 22.30, 114.17, 20),
  ('Busan', 'KRPUS', 'South Korea', 35.10, 129.04, 20),
  ('Kaohsiung', 'TWKHH', 'Taiwan', 22.61, 120.28, 20),
  ('Yokohama', 'JPYOK', 'Japan', 35.44, 139.64, 20),
  ('Tokyo', 'JPTYO', 'Japan', 35.63, 139.77, 20),
  ('Kobe', 'JPUKB', 'Japan', 34.68, 135.20, 20),
  ('Singapore', 'SGSIN', 'Singapore', 1.29, 103.85, 25),
  ('Port Klang', 'MYPKG', 'Malaysia', 3.00, 101.39, 20),
  ('Tanjung Pelepas', 'MYTPP', 'Malaysia', 1.36, 103.55, 20),
  ('Laem Chabang', 'THLCH', 'Thailand', 13.08, 100.88, 20),
  ('Ho Chi Minh City', 'VNSGN', 'Vietnam', 10.76, 106.76, 20),
  ('Manila', 'PHMNL', 'Philippines', 14.58, 120.95, 20),
  ('Jakarta', 'IDJKT', 'Indonesia', -6.10, 106.88, 20),
  ('Jebel Ali', 'AEJEA', 'United Arab Emirates', 25.01, 55.06, 20),
  ('Nhava Sheva', 'INNSA', 'India', 18.95, 72.95, 20),
  ('Colombo', 'LKCMB', 'Sri Lanka', 6.95, 79.84, 20),
  ('Rotterdam', 'NLRTM', 'Netherlands', 51.95, 4.14, 25),
  ('Antwerp', 'BEANR', 'Belgium', 51.27, 4.34, 20),
  ('Hamburg', 'DEHAM', 'Germany', 53.54, 9.97, 20),
  ('Bremerhaven', 'DEBRV', 'Germany', 53.55, 8.58, 20),
  ('Felixstowe', 'GBFXT', 'United Kingdom', 51.96, 1.32, 20),
  ('Le Havre', 'FRLEH', 'France', 49.49, 0.11, 20),
  ('Valencia', 'ESVLC', 'Spain', 39.44, -0.31, 20),
  ('Algeciras', 'ESALG', 'Spain', 36.14, -5.44, 20),
  ('Piraeus', 'GRPIR', 'Greece', 37.94, 23.63, 20),
  ('Gioia Tauro', 'ITGIT', 'Italy', 38.45, 15.90, 20),
  ('Tanger Med', 'MATNG', 'Morocco', 35.88, -5.50, 20),
  ('Durban', 'ZADUR', 'South Africa', -29.87, 31.03, 20),
  ('Los Angeles', 'USLAX', 'United States', 33.73, -118.26, 20),
  ('Long Beach', 'USLGB', 'United States', 33.75, -118.20, 20),
  ('Oakland', 'USOAK', 'United States', 37.80, -122.32, 20),
  ('Seattle', 'USSEA', 'United States', 47.58, -122.35, 20),
  ('New York/New Jersey', 'USNYC', 'United States', 40.67, -74.13, 25),
  ('Savannah', 'USSAV', 'United States', 32.08, -81.09, 20),
  ('Charleston', 'USCHS', 'United States', 32.79, -79.92, 20),
  ('Norfolk', 'USORF', 'United States', 36.90, -76.33, 20),
  ('Houston', 'USHOU', 'United States', 29.72, -95.03, 20),
  ('Miami', 'USMIA', 'United States', 25.77, -80.17, 20),
  ('Vancouver', 'CAVAN', 'Canada', 49.29, -123.11, 25),
  ('Prince Rupert', 'CAPRR', 'Canada', 54.32, -130.32, 20),
  ('Santos', 'BRSSZ', 'Brazil', -23.96, -46.30, 20),
  ('Callao', 'PECLL', 'Peru', -12.05, -77.15, 20),
  ('Cartagena', 'COCTG', 'Colombia', 10.40, -75.51, 20),
  ('Balboa', 'PABLB', 'Panama', 8.95, -79.57, 20),
  ('Sydney', 'AUSYD', 'Australia', -33.87, 151.21, 20),
  ('Melbourne', 'AUMEL', 'Australia', -37.84, 144.93, 20),
  ('Auckland', 'NZAKL', 'New Zealand', -36.84, 174.77, 20)
ON CONFLICT (unlocode) DO NOTHING;

-- Structured origin/destination references, additive and optional.
-- Existing shipments (all of which only have the free-text origin/
-- destination columns) are entirely unaffected: both columns default to
-- NULL, nothing is backfilled or inferred, and every existing display path
-- keeps reading the free-text columns exactly as before.
ALTER TABLE public.shipments
  ADD COLUMN IF NOT EXISTS origin_port_id uuid REFERENCES public.ports(id),
  ADD COLUMN IF NOT EXISTS destination_port_id uuid REFERENCES public.ports(id);

CREATE INDEX IF NOT EXISTS shipments_origin_port_idx ON public.shipments (origin_port_id);
CREATE INDEX IF NOT EXISTS shipments_destination_port_idx ON public.shipments (destination_port_id);
