-- Minimal debounce state for AIS-derived status decisions (Phase 3).
--
-- The AIS decision layer only ever sees the *latest* vessel_positions row
-- (no history table), so "require consecutive qualifying observations"
-- needs a tiny persisted marker instead of scanning past messages: the
-- status a fresh AIS reading is currently proposing, and when it was first
-- proposed. A candidate is only promoted to the shipment's actual status
-- once it has held for a minimum confirmation window across at least two
-- separate evaluations — this is what prevents a single noisy AIS point
-- from flapping the status.
ALTER TABLE public.shipments
  ADD COLUMN IF NOT EXISTS ais_pending_status public.shipment_status,
  ADD COLUMN IF NOT EXISTS ais_pending_since timestamptz;
