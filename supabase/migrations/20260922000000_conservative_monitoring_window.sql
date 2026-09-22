-- Reliability Phase 1: conservative AIS monitoring window.
--
-- Lifecycle automation now opens 48 hours before a shipment's planned
-- departure instead of 7 days (the code default in lib/lifecycle.ts changed
-- to 2). Stored settings override code defaults, and the live workspace still
-- holds the original seeded value of 7, so without this the change would have
-- no effect in production.
--
-- Only touches the row if it is still exactly the seeded default — a
-- deliberately customised value is left alone. Idempotent: a second run
-- matches nothing. Does not alter schema, and adds no new setting rows (the
-- new `ais_lifecycle_fresh_minutes` setting falls back to its code default of
-- 30 until someone chooses to store a different value).
UPDATE public.app_settings
SET value = '2'::jsonb
WHERE key = 'monitoring_start_offset_days'
  AND value = '7'::jsonb;
