-- Reliability Phase 2: atomic, idempotent, operator-safe lifecycle transitions.
--
-- Before this, an automated status change was 3-5 separate unconditional REST
-- writes (pending state, shipment row, event, alert, monitoring event). Nothing
-- checked the status the caller had read, nothing tied the writes together, and
-- nothing stopped two concurrent evaluations from both advancing the shipment,
-- or from overwriting an operator's correction. This migration moves the
-- critical write into the database:
--
--   apply_automation_decision()    the ONE persistence path for every automatic
--                                  lifecycle / monitoring / AIS-debounce change
--   apply_manual_status_change()   operator corrections (advance / override)
--   resume_shipment_automation()   operator lifts an automation hold early
--   shipments_guard_automation_state()  trigger: stale-evidence invalidation and
--                                  hold, enforced even for writers that bypass
--                                  the RPCs
--
-- Privileges: apply_automation_decision() is called only by the server (service
-- role) and is NOT executable by anon/authenticated. The two operator functions
-- are called from the browser and stay executable by anon/authenticated. All
-- three are SECURITY INVOKER, so they can do nothing the caller could not
-- already do directly against the (currently open) tables.
--
-- Additive and safe to apply BEFORE the application code that calls these: the
-- new columns are nullable, the unique indexes ignore existing rows (NULL
-- keys), and the trigger is compatible with the code that is running today.
-- Idempotent — safe to apply more than once.

-- ---------------------------------------------------------------- columns ---

-- When set and in the future, automation stands down for this shipment: an
-- operator has just corrected its status, and automatic progression must not
-- immediately undo that decision.
ALTER TABLE public.shipments
  ADD COLUMN IF NOT EXISTS automation_hold_until timestamptz;

-- Deterministic identity of a logical automated transition. NULL for every
-- event/alert that predates this migration and for all manual events.
ALTER TABLE public.shipment_events ADD COLUMN IF NOT EXISTS dedupe_key text;
ALTER TABLE public.alerts          ADD COLUMN IF NOT EXISTS dedupe_key text;

-- Makes a duplicate of the same logical transition impossible to insert. Partial
-- (NOT NULL keys only) so existing rows and manual events are unaffected, and a
-- legitimate later transition — which has a different key — is never blocked.
CREATE UNIQUE INDEX IF NOT EXISTS shipment_events_dedupe_key_idx
  ON public.shipment_events (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS alerts_dedupe_key_idx
  ON public.alerts (dedupe_key) WHERE dedupe_key IS NOT NULL;

-- ---------------------------------------------------------------- helpers ---

-- Position of a status in the active lifecycle (1 = Scheduled ... 6 = Arrived);
-- NULL for the retired legacy statuses, which automation never touches.
CREATE OR REPLACE FUNCTION public.shipment_status_rank(s public.shipment_status)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT array_position(
    ARRAY['Scheduled','Booked','Departed','In Transit','Approaching Destination','Arrived'],
    s::text
  )
$$;

-- How long automation stands down after an operator's backward correction.
-- Workspace-configurable through app_settings 'automation_hold_hours'; default
-- 24, clamped to 0..168 (0 disables the hold).
CREATE OR REPLACE FUNCTION public.automation_hold_hours()
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT least(greatest(coalesce(
    (SELECT (value #>> '{}')::numeric FROM public.app_settings WHERE key = 'automation_hold_hours'),
    24), 0), 168)
$$;

-- ----------------------------------------------------------------- trigger ---

CREATE OR REPLACE FUNCTION public.shipments_guard_automation_state()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  hold_hours numeric;
BEGIN
  -- Evidence collected against one configuration must never confirm against
  -- another: if anything the AIS candidate was judged against changes, the
  -- pending candidate is void.
  IF NEW.vessel_mmsi IS DISTINCT FROM OLD.vessel_mmsi
     OR NEW.origin_port_id IS DISTINCT FROM OLD.origin_port_id
     OR NEW.destination_port_id IS DISTINCT FROM OLD.destination_port_id
     OR NEW.planned_etd IS DISTINCT FROM OLD.planned_etd THEN
    NEW.ais_pending_status := NULL;
    NEW.ais_pending_since := NULL;
  END IF;

  -- Any status change that did not come through apply_automation_decision()
  -- is an operator decision by definition. It voids the pending candidate and,
  -- if it moved the shipment BACKWARD (a correction automation could undo),
  -- puts automation on hold so it cannot immediately do so.
  IF NEW.status IS DISTINCT FROM OLD.status
     AND coalesce(current_setting('whitewind.transition_source', true), '') <> 'automation' THEN
    NEW.ais_pending_status := NULL;
    NEW.ais_pending_since := NULL;
    IF coalesce(public.shipment_status_rank(NEW.status), 0) < coalesce(public.shipment_status_rank(OLD.status), 0)
       AND NEW.automation_hold_until IS NOT DISTINCT FROM OLD.automation_hold_until THEN
      hold_hours := public.automation_hold_hours();
      IF hold_hours > 0 THEN
        NEW.automation_hold_until := clock_timestamp() + make_interval(secs => hold_hours * 3600);
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS shipments_guard_automation_state ON public.shipments;
CREATE TRIGGER shipments_guard_automation_state
  BEFORE UPDATE ON public.shipments
  FOR EACH ROW EXECUTE FUNCTION public.shipments_guard_automation_state();

-- ------------------------------------------------ automated decisions (RPC) ---

-- Applies one automation decision atomically. Everything below happens in a
-- single transaction under a row lock on the shipment, so concurrent callers
-- are serialised and a failure anywhere rolls the whole thing back — there is
-- never a status change without its event.
--
-- Hold times are compared and written with clock_timestamp(), not now(): now() is
-- the transaction START time, and a caller that queued behind the row lock started
-- before the writer it waited for, so it would see that writer's hold as still in
-- the future (30 simultaneous resumes would each "resume" it again).
--
-- Returns jsonb { outcome, status_changed, monitoring_changed, pending_changed, ... }
--   applied    the decision was written
--   noop       nothing to change
--   conflict   the shipment no longer matches what the caller evaluated (someone
--              else won the race, or an operator changed it); nothing written
--   held       an operator hold is in force; nothing written
--   duplicate  this logical transition was already recorded; nothing written
--   rejected   not a forward move between active statuses; nothing written
--   not_found  no such shipment
CREATE OR REPLACE FUNCTION public.apply_automation_decision(
  p_shipment_id             uuid,
  p_expected_status         public.shipment_status,
  p_new_status              public.shipment_status,
  p_expected_monitoring_state text,
  p_new_monitoring_state    text,
  p_expected_pending_status public.shipment_status DEFAULT NULL,
  p_expected_pending_since  timestamptz DEFAULT NULL,
  p_new_pending_status      public.shipment_status DEFAULT NULL,
  p_new_pending_since       timestamptz DEFAULT NULL,
  p_update_pending          boolean DEFAULT false,
  p_source                  text DEFAULT 'system',
  p_actor                   text DEFAULT 'Automation',
  p_reason                  text DEFAULT NULL,
  p_monitoring_reason       text DEFAULT NULL,
  p_status_dedupe_key       text DEFAULT NULL,
  p_occurred_at             timestamptz DEFAULT NULL,
  p_stamp_actual_departure  timestamptz DEFAULT NULL,
  p_stamp_actual_arrival    timestamptz DEFAULT NULL,
  p_alert_message           text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v                    public.shipments%ROWTYPE;
  status_changing      boolean := p_new_status IS DISTINCT FROM p_expected_status;
  monitoring_changing  boolean := p_new_monitoring_state IS DISTINCT FROM p_expected_monitoring_state;
  pending_changing     boolean := p_update_pending AND (
                                    p_new_pending_status IS DISTINCT FROM p_expected_pending_status
                                    OR p_new_pending_since IS DISTINCT FROM p_expected_pending_since);
  monitoring_applied   boolean := false;
  occurred             timestamptz := coalesce(p_occurred_at, now());
BEGIN
  IF NOT (status_changing OR monitoring_changing OR pending_changing) THEN
    RETURN jsonb_build_object('outcome', 'noop');
  END IF;

  -- Serialise every writer of this shipment. Concurrent callers queue here.
  SELECT * INTO v FROM public.shipments WHERE id = p_shipment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  -- An operator's correction is in force: automation stands down entirely.
  IF (status_changing OR pending_changing)
     AND v.automation_hold_until IS NOT NULL AND v.automation_hold_until > clock_timestamp() THEN
    RETURN jsonb_build_object('outcome', 'held', 'hold_until', v.automation_hold_until);
  END IF;

  -- automation_hold_until is also the evidence boundary: once a hold has
  -- ended (expired, or lifted by an operator, which sets it to that instant),
  -- an AIS observation at or before it never starts a candidate. Evidence
  -- gathered during a hold must not confirm the moment it is over.
  IF pending_changing AND p_new_pending_since IS NOT NULL
     AND v.automation_hold_until IS NOT NULL AND p_new_pending_since <= v.automation_hold_until THEN
    RETURN jsonb_build_object('outcome', 'held', 'reason', 'evidence_predates_hold', 'hold_until', v.automation_hold_until);
  END IF;

  -- Compare-and-set: act only on the exact state the caller evaluated.
  IF (status_changing OR pending_changing) AND v.status IS DISTINCT FROM p_expected_status THEN
    RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'status_changed', 'current_status', v.status);
  END IF;
  IF pending_changing AND (
       v.ais_pending_status IS DISTINCT FROM p_expected_pending_status
       OR v.ais_pending_since IS DISTINCT FROM p_expected_pending_since) THEN
    RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'pending_changed');
  END IF;

  -- Automation only ever moves a shipment forward between active statuses.
  IF status_changing AND (
       public.shipment_status_rank(p_expected_status) IS NULL
       OR public.shipment_status_rank(p_new_status) IS NULL
       OR public.shipment_status_rank(p_new_status) <= public.shipment_status_rank(p_expected_status)) THEN
    RETURN jsonb_build_object('outcome', 'rejected', 'reason', 'not_a_forward_move');
  END IF;

  -- Monitoring state is compare-and-set on its own: if another writer already
  -- moved it, the change is simply already done — skip it, don't fail.
  monitoring_applied := monitoring_changing AND v.monitoring_state = p_expected_monitoring_state;

  IF status_changing THEN
    -- The same logical transition can only ever be recorded once.
    IF p_status_dedupe_key IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.shipment_events WHERE dedupe_key = p_status_dedupe_key) THEN
      RETURN jsonb_build_object('outcome', 'duplicate');
    END IF;

    -- Tell shipments_guard_automation_state() this change is automation's,
    -- not an operator's (transaction-local).
    PERFORM set_config('whitewind.transition_source', 'automation', true);

    UPDATE public.shipments
       SET status               = p_new_status,
           ais_pending_status   = NULL,
           ais_pending_since    = NULL,
           monitoring_state     = CASE WHEN monitoring_applied THEN p_new_monitoring_state ELSE monitoring_state END,
           -- Stamp the milestone from the AIS observation, never overwriting
           -- a value an operator (or an earlier stamp) already recorded.
           actual_departure     = coalesce(actual_departure, p_stamp_actual_departure),
           actual_arrival       = coalesce(actual_arrival, p_stamp_actual_arrival),
           last_synced_at       = now()
     WHERE id = p_shipment_id;

    INSERT INTO public.shipment_events
      (shipment_id, event_type, category, field, from_value, to_value, source, automated, actor, reason, occurred_at, dedupe_key)
    VALUES
      (p_shipment_id, 'status_auto', 'status', 'Status', v.status::text, p_new_status::text,
       p_source, true, p_actor, p_reason, occurred, p_status_dedupe_key);

    IF p_alert_message IS NOT NULL THEN
      INSERT INTO public.alerts (shipment_id, message, from_status, to_status, dedupe_key)
      VALUES (p_shipment_id, p_alert_message, v.status, p_new_status, p_status_dedupe_key);
    END IF;
  ELSE
    UPDATE public.shipments
       SET monitoring_state   = CASE WHEN monitoring_applied THEN p_new_monitoring_state ELSE monitoring_state END,
           ais_pending_status = CASE WHEN pending_changing THEN p_new_pending_status ELSE ais_pending_status END,
           ais_pending_since  = CASE WHEN pending_changing THEN p_new_pending_since ELSE ais_pending_since END,
           last_synced_at     = now()
     WHERE id = p_shipment_id;
  END IF;

  IF monitoring_applied THEN
    INSERT INTO public.shipment_events
      (shipment_id, event_type, category, field, from_value, to_value, source, automated, actor, reason, occurred_at)
    VALUES
      (p_shipment_id, 'monitoring_auto', 'monitoring', 'Monitoring state', p_expected_monitoring_state, p_new_monitoring_state,
       'system', true, p_actor, coalesce(p_monitoring_reason, p_reason), occurred);
  END IF;

  RETURN jsonb_build_object(
    'outcome', 'applied',
    'status_changed', status_changing,
    'monitoring_changed', monitoring_applied,
    'pending_changed', pending_changing OR status_changing
  );
END;
$$;

-- ----------------------------------------------------- operator corrections ---

-- An operator changes a shipment's lifecycle status. Recorded as a MANUAL event
-- (never disguised as automation), voids any pending AIS candidate, and — when
-- the change is backward, i.e. a correction automation could otherwise undo —
-- puts automation on hold and clears any milestone timestamp the corrected
-- status now contradicts (an Approaching shipment has no actual_arrival).
--
-- p_expected_status: when given, the change applies only if the shipment is
-- still in that status (used by "advance", so a stale page can't regress a
-- shipment automation has since moved). Leave NULL for an explicit override.
CREATE OR REPLACE FUNCTION public.apply_manual_status_change(
  p_shipment_id     uuid,
  p_new_status      public.shipment_status,
  p_expected_status public.shipment_status DEFAULT NULL,
  p_event_type      text DEFAULT 'status_override',
  p_reason          text DEFAULT NULL,
  p_actor           text DEFAULT 'Operator',
  p_alert_message   text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v            public.shipments%ROWTYPE;
  old_rank     integer;
  new_rank     integer;
  backward     boolean;
  hold_hours   numeric;
  hold_until   timestamptz := NULL;
  clear_dep    boolean;
  clear_arr    boolean;
  note         text := '';
BEGIN
  SELECT * INTO v FROM public.shipments WHERE id = p_shipment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  IF p_expected_status IS NOT NULL AND v.status IS DISTINCT FROM p_expected_status THEN
    RETURN jsonb_build_object('outcome', 'conflict', 'reason', 'status_changed', 'current_status', v.status);
  END IF;
  IF v.status = p_new_status THEN
    RETURN jsonb_build_object('outcome', 'noop');
  END IF;

  old_rank := public.shipment_status_rank(v.status);
  new_rank := public.shipment_status_rank(p_new_status);
  backward := new_rank IS NOT NULL AND old_rank IS NOT NULL AND new_rank < old_rank;

  IF backward THEN
    hold_hours := public.automation_hold_hours();
    IF hold_hours > 0 THEN
      hold_until := clock_timestamp() + make_interval(secs => hold_hours * 3600);
    END IF;
  END IF;

  clear_dep := backward AND new_rank < public.shipment_status_rank('Departed') AND v.actual_departure IS NOT NULL;
  clear_arr := backward AND new_rank < public.shipment_status_rank('Arrived')  AND v.actual_arrival IS NOT NULL;
  IF clear_dep THEN note := note || format(' Cleared actual_departure (%s).', to_char(v.actual_departure AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"')); END IF;
  IF clear_arr THEN note := note || format(' Cleared actual_arrival (%s).',   to_char(v.actual_arrival   AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"')); END IF;

  UPDATE public.shipments
     SET status                = p_new_status,
         ais_pending_status    = NULL,
         ais_pending_since     = NULL,
         automation_hold_until = coalesce(hold_until, automation_hold_until),
         actual_departure      = CASE WHEN clear_dep THEN NULL ELSE actual_departure END,
         actual_arrival        = CASE WHEN clear_arr THEN NULL ELSE actual_arrival END
   WHERE id = p_shipment_id;

  INSERT INTO public.shipment_events
    (shipment_id, event_type, category, field, from_value, to_value, source, automated, actor, reason)
  VALUES
    (p_shipment_id, p_event_type, 'status', 'Status', v.status::text, p_new_status::text,
     'manual', false, p_actor, nullif(trim(coalesce(p_reason, '') || note), ''));

  IF p_alert_message IS NOT NULL THEN
    INSERT INTO public.alerts (shipment_id, message, from_status, to_status)
    VALUES (p_shipment_id, p_alert_message, v.status, p_new_status);
  END IF;

  RETURN jsonb_build_object(
    'outcome', 'applied',
    'backward', backward,
    'hold_until', hold_until,
    'cleared_actual_departure', clear_dep,
    'cleared_actual_arrival', clear_arr
  );
END;
$$;

-- An operator lifts an automation hold before it expires. The hold ends at this
-- instant (automation_hold_until is set to that time, so it is no longer in force)
-- and that instant remains the evidence boundary: any pending candidate is
-- voided and no AIS observation taken up to now can start a new one. Automation
-- restarts only from observations made after the operator resumed it.
-- A no-op when no hold is in force.
CREATE OR REPLACE FUNCTION public.resume_shipment_automation(
  p_shipment_id uuid,
  p_actor       text DEFAULT 'Operator'
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v public.shipments%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.shipments WHERE id = p_shipment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  IF v.automation_hold_until IS NULL OR v.automation_hold_until <= clock_timestamp() THEN
    RETURN jsonb_build_object('outcome', 'noop');
  END IF;

  UPDATE public.shipments
     SET automation_hold_until = clock_timestamp(), ais_pending_status = NULL, ais_pending_since = NULL
   WHERE id = p_shipment_id;

  INSERT INTO public.shipment_events
    (shipment_id, event_type, category, field, from_value, to_value, source, automated, actor, reason)
  VALUES
    (p_shipment_id, 'automation_resumed', 'event', 'Automation hold',
     'Held until ' || to_char(v.automation_hold_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"'),
     'Resumed', 'manual', false, p_actor, 'Automation resumed by operator');

  RETURN jsonb_build_object('outcome', 'applied');
END;
$$;

-- ---------------------------------------------------------------- privileges ---
--
-- New functions in this project's public schema get EXECUTE for PUBLIC and for
-- anon / authenticated / service_role automatically, so it is revoked
-- explicitly and granted back only where it is needed.
--
-- apply_automation_decision(): server only. The webhook and the daily sweep call
--   it with the service-role client; nothing in the browser does. Keeping anon
--   and authenticated off it means the public API cannot mint an "automated"
--   transition (an AIS-sourced event, an automatic alert, an actual-departure
--   stamp) in one call.
-- apply_manual_status_change(), resume_shipment_automation(): called by the
--   operator UI (anon key today), so they stay executable by anon/authenticated.
--
-- All are SECURITY INVOKER: they run with the caller's privileges and touch only
-- shipments, shipment_events and alerts, each keyed by the shipment id argument.
-- Under the workspace's current open RLS a caller can already write those tables
-- directly, so none of this widens what an anonymous caller can do; tightening
-- the tables themselves belongs to the later authentication / RLS phase.
REVOKE ALL ON FUNCTION public.apply_automation_decision(uuid, public.shipment_status, public.shipment_status, text, text, public.shipment_status, timestamptz, public.shipment_status, timestamptz, boolean, text, text, text, text, text, timestamptz, timestamptz, timestamptz, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_automation_decision(uuid, public.shipment_status, public.shipment_status, text, text, public.shipment_status, timestamptz, public.shipment_status, timestamptz, boolean, text, text, text, text, text, timestamptz, timestamptz, timestamptz, text) TO service_role;

REVOKE ALL ON FUNCTION public.apply_manual_status_change(uuid, public.shipment_status, public.shipment_status, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_manual_status_change(uuid, public.shipment_status, public.shipment_status, text, text, text, text) TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.resume_shipment_automation(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resume_shipment_automation(uuid, text) TO anon, authenticated, service_role;

-- A trigger function is never called directly; it needs no EXECUTE for anyone
-- (a trigger fires regardless of the invoking role's EXECUTE privilege).
REVOKE ALL ON FUNCTION public.shipments_guard_automation_state() FROM PUBLIC, anon, authenticated;
