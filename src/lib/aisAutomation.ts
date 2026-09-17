/**
 * AIS-derived shipment status decision layer (Phase 3).
 *
 * Separate from both `scripts/ais-listener.ts` (ingestion only — it never
 * makes business decisions) and `lib/autoStatus.ts` (the existing pure
 * date-based automation, left untouched). This module answers one question:
 * "given a shipment and the latest known position of its vessel, what — if
 * anything — should change?" It is pure and deterministic, so it is fully
 * testable with fixtures instead of a live AIS feed.
 *
 * AIS is only trusted for the transitions it can actually observe:
 *   Booked -> Departed               (vessel confirmed under way)
 *   Departed -> In Transit           (vessel still confirmed under way)
 *   In Transit -> Approaching Dest.  (within the ETA window, AIS still live)
 *   Approaching Dest. -> Arrived     (vessel confirmed stopped)
 * Scheduled -> Booked is a booking/paperwork milestone, not an AIS-observable
 * event, so AIS never touches it. An actual arrival timestamp (recorded by
 * whatever process sets it) is authoritative and bypasses AIS entirely, same
 * as the existing date-based automation.
 *
 * Flap prevention: since only the *latest* position is persisted (no AIS
 * history), "consecutive qualifying observations" is implemented with two
 * tiny persisted columns (`ais_pending_status` / `ais_pending_since`) — a
 * candidate must be observed again, at least AIS_CONFIRMATION_MINUTES later,
 * before it is promoted to the shipment's real status. A candidate that no
 * longer matches what the current status would need next (e.g. a manual
 * status change moved past it) is naturally superseded on the next
 * evaluation, not carried over.
 *
 * Never regresses: every candidate is exactly the shipment's immediate next
 * step in ACTIVE_STATUSES order, so this can only ever move status forward
 * — identical invariant to the existing `advanceTo()` pattern. A manual
 * status change simply becomes the new floor AIS advances from next.
 *
 * Reuses the existing event architecture: `applyAisDecision` persists
 * through the existing `applyAutomation()` unchanged, tagging the event
 * source as "ais" (already a valid `EventSource`, already understood by
 * `SourceTag` in the UI) so automatic AIS moves stay clearly distinguishable
 * from manual edits and from the plain date-based sweep. No event is
 * written when status hasn't changed — `applyAutomation()` already
 * guarantees that.
 */
import {
  ACTIVE_STATUSES,
  applyAutomation,
  isLegacyStatus,
  updateShipment,
  type ActiveShipmentStatus,
  type Db,
  type EventSource,
  type MonitoringState,
  type Shipment,
  type ShipmentStatus,
  type VesselPosition,
} from "@/lib/api";
import { supabase } from "@/integrations/supabase/client";
import { monitoringInfo, type MonitoringConfig } from "@/lib/lifecycle";
import { APPROACHING_WITHIN_HOURS } from "@/lib/autoStatus";

const HOUR = 3_600_000;
const MINUTE = 60_000;

/** Beyond this age, a position is no longer trusted as current evidence. */
export const AIS_STALE_HOURS = 24;
/** A candidate must be observed again at least this long after it was first proposed before it is promoted. */
export const AIS_CONFIRMATION_MINUTES = 15;
/**
 * A pending candidate older than this no longer counts as corroboration —
 * it's treated as expired and restarted from the current observation.
 * Without this, a candidate that sat pending for days (e.g. an AIS worker
 * outage, or a vessel out of coverage) would instantly "confirm" on a single
 * fresh reading once AIS_CONFIRMATION_MINUTES had trivially elapsed — the
 * exact single-point flap this debounce exists to prevent. 2 hours is
 * generous relative to normal AIS reporting cadence (even a moored vessel
 * reports every ~3 minutes) while still requiring genuinely close-together
 * observations.
 */
export const AIS_PENDING_MAX_AGE_MINUTES = 120;
/** At/above this SOG, a vessel is considered moving under its own power (not sitting at berth). */
export const DEPARTURE_MIN_SOG_KNOTS = 2;
/** At/below this SOG (with a stopped nav status), a vessel is considered stopped. */
export const ARRIVAL_MAX_SOG_KNOTS = 0.5;

/** ITU-R M.1371 navigational status codes meaning "under way". */
const UNDERWAY_NAV_STATUS = new Set(["0", "8"]);
/** ITU-R M.1371 navigational status codes meaning "stopped". */
const STOPPED_NAV_STATUS = new Set(["1", "5"]);

const rank = (status: ActiveShipmentStatus) => ACTIVE_STATUSES.indexOf(status);

export type AisDecision = {
  status: ShipmentStatus;
  monitoring_state: MonitoringState;
  reason: string;
  source: EventSource;
  statusChanged: boolean;
  monitoringChanged: boolean;
  /** Debounce state to persist — null clears any pending candidate. */
  pendingStatus: ActiveShipmentStatus | null;
  pendingSince: string | null;
};

/** Exported so other callers (the date-based automation guard, the UI) use
 * this exact same freshness definition rather than a second one. */
export function isAisFresh(position: VesselPosition | null, now: number): boolean {
  if (!position) return false;
  const ts = position.position_timestamp ?? position.received_at;
  if (!ts) return false;
  const ageHours = (now - new Date(ts).getTime()) / HOUR;
  return ageHours <= AIS_STALE_HOURS;
}

function isUnderway(position: VesselPosition): boolean {
  if (position.sog == null || position.sog < DEPARTURE_MIN_SOG_KNOTS) return false;
  // nav_status is a secondary sanity check, not required — some Class B
  // transponders don't populate it reliably. SOG is the primary signal.
  if (position.nav_status != null && STOPPED_NAV_STATUS.has(position.nav_status)) return false;
  return true;
}

function isStopped(position: VesselPosition): boolean {
  // Conservative on purpose: this is the highest-stakes transition (task
  // explicitly warns against a false "Arrived"), so an explicit stopped
  // nav status is required — low SOG alone could just be a mid-transit
  // slowdown.
  //
  // No hidden geographic assumption: this only proves the vessel has
  // stopped somewhere, not that it has stopped at the shipment's actual
  // destination (no coordinates exist to check that — see
  // etaWithinApproachWindow). A vessel anchored elsewhere entirely (a
  // waypoint, a different port, a weather hold) after already reaching
  // "Approaching Destination" would satisfy this. Reaching this rule at
  // all already implies the ETA-window proxy fired first, which is the
  // full extent of the location signal available in this schema.
  if (position.nav_status == null || !STOPPED_NAV_STATUS.has(position.nav_status)) return false;
  if (position.sog != null && position.sog > ARRIVAL_MAX_SOG_KNOTS) return false;
  return true;
}

/**
 * MVP approximation, not geographic destination detection: this repo has no
 * port coordinates for origin/destination (they're free-text strings) and no
 * ports reference table, so "approaching the destination" cannot be computed
 * from actual distance. Proximity to the current ETA is used as a time-based
 * stand-in instead. A real geofence would need a schema addition (port
 * lat/lon or a ports table) — out of scope for this phase.
 */
function etaWithinApproachWindow(shipment: Shipment, now: number): boolean {
  const eta = shipment.eta ?? shipment.planned_eta;
  if (!eta) return false;
  const hoursToEta = (new Date(eta).getTime() - now) / HOUR;
  return hoursToEta <= APPROACHING_WITHIN_HOURS;
}

type Evidence = { ok: boolean; reason: string };

function evidenceFor(nextCandidate: ActiveShipmentStatus, shipment: Shipment, position: VesselPosition | null, now: number): Evidence {
  const fresh = isAisFresh(position, now);
  switch (nextCandidate) {
    case "Departed": {
      const ok = fresh && isUnderway(position!);
      return {
        ok,
        reason: ok
          ? `AIS shows the vessel under way (SOG ${position!.sog} kn)`
          : fresh
            ? "AIS position received, but the vessel is not yet confirmed under way"
            : "No fresh AIS position — cannot confirm departure",
      };
    }
    case "In Transit": {
      const ok = fresh && isUnderway(position!);
      return {
        ok,
        reason: ok
          ? `AIS confirms the vessel is still under way (SOG ${position!.sog} kn)`
          : fresh
            ? "AIS position received, but the vessel is no longer confirmed under way"
            : "No fresh AIS position since departure",
      };
    }
    case "Approaching Destination": {
      const withinWindow = etaWithinApproachWindow(shipment, now);
      const ok = fresh && withinWindow;
      return {
        ok,
        reason: !withinWindow
          ? "Not yet within the approach window"
          : fresh
            ? `Within ${APPROACHING_WITHIN_HOURS}h of the current ETA and AIS is still reporting`
            : `Within ${APPROACHING_WITHIN_HOURS}h of the current ETA, but AIS has gone stale`,
      };
    }
    case "Arrived": {
      const ok = fresh && isStopped(position!);
      return {
        ok,
        reason: ok
          ? "AIS shows the vessel stopped (moored/at anchor)"
          : fresh
            ? "AIS position received, but the vessel is not yet confirmed stopped"
            : "No fresh AIS position — cannot confirm arrival",
      };
    }
    default:
      // Scheduled -> Booked: not AIS-observable.
      return { ok: false, reason: "Not an AIS-observable transition" };
  }
}

/** Debounces a candidate against the shipment's persisted pending state. */
function confirmCandidate(
  shipment: Shipment,
  candidate: ActiveShipmentStatus,
  evidenceOk: boolean,
  now: number,
): { advance: boolean; pendingStatus: ActiveShipmentStatus | null; pendingSince: string | null } {
  if (!evidenceOk) {
    return { advance: false, pendingStatus: null, pendingSince: null };
  }

  const storedPending = shipment.ais_pending_status as ActiveShipmentStatus | null;
  const storedSince = shipment.ais_pending_since;

  if (storedPending === candidate && storedSince) {
    const elapsedMinutes = (now - new Date(storedSince).getTime()) / MINUTE;
    if (elapsedMinutes > AIS_PENDING_MAX_AGE_MINUTES) {
      // Too old to count as corroboration — restart the debounce window
      // from this fresh observation rather than treating a stale marker
      // plus one new reading as two agreeing observations.
      return { advance: false, pendingStatus: candidate, pendingSince: new Date(now).toISOString() };
    }
    if (elapsedMinutes >= AIS_CONFIRMATION_MINUTES) {
      return { advance: true, pendingStatus: null, pendingSince: null };
    }
    return { advance: false, pendingStatus: candidate, pendingSince: storedSince };
  }

  // First qualifying observation for this candidate — or a different
  // candidate was pending before (e.g. a manual change moved the shipment
  // past it), which this naturally supersedes rather than carrying over.
  return { advance: false, pendingStatus: candidate, pendingSince: new Date(now).toISOString() };
}

/**
 * Derives the status an AIS-informed evaluation would set. Pure — safe to
 * call repeatedly with the same inputs; only mutates via the returned
 * decision's pending fields, which the caller persists.
 */
export function deriveAisAutomation(
  shipment: Shipment,
  position: VesselPosition | null,
  config: MonitoringConfig,
  now: number = Date.now(),
): AisDecision {
  const monitoring = monitoringInfo(shipment, config);

  if (isLegacyStatus(shipment.status)) {
    return {
      status: shipment.status,
      monitoring_state: monitoring.state,
      reason: monitoring.reason,
      source: "system",
      statusChanged: false,
      monitoringChanged: monitoring.state !== shipment.monitoring_state,
      pendingStatus: null,
      pendingSince: null,
    };
  }

  let status = shipment.status as ActiveShipmentStatus;
  let reason = monitoring.reason;
  let source: EventSource = "system";
  let pendingStatus: ActiveShipmentStatus | null = null;
  let pendingSince: string | null = null;

  // Authoritative and unconditional, same as the existing date-based
  // automation — AIS never needs to (and cannot) override a recorded
  // actual arrival.
  if (shipment.actual_arrival && rank("Arrived") > rank(status)) {
    status = "Arrived";
    reason = "Actual arrival recorded";
  } else if (monitoring.state === "Active Monitoring" && status !== "Scheduled") {
    const nextCandidate = ACTIVE_STATUSES[rank(status) + 1] as ActiveShipmentStatus | undefined;

    if (nextCandidate) {
      const evidence = evidenceFor(nextCandidate, shipment, position, now);
      const result = confirmCandidate(shipment, nextCandidate, evidence.ok, now);
      pendingStatus = result.pendingStatus;
      pendingSince = result.pendingSince;
      reason = evidence.reason;

      if (result.advance) {
        status = nextCandidate;
        source = "ais";
      }
    }
  }

  return {
    status,
    monitoring_state: monitoring.state,
    reason,
    source,
    statusChanged: status !== shipment.status,
    monitoringChanged: monitoring.state !== shipment.monitoring_state,
    pendingStatus,
    pendingSince,
  };
}

/**
 * Persists an AIS-derived decision: updates the debounce columns (only when
 * they actually changed) and then reuses the existing `applyAutomation()`
 * verbatim for the status/monitoring write and event/alert recording — so
 * duplicate-event prevention, append-only history, and the manual/automatic
 * distinction all come from the one already-trusted code path.
 */
export async function applyAisDecision(
  shipment: Shipment,
  decision: AisDecision,
  db: Db = supabase,
): Promise<void> {
  if (decision.pendingStatus !== shipment.ais_pending_status || decision.pendingSince !== shipment.ais_pending_since) {
    await updateShipment(
      shipment.id,
      { ais_pending_status: decision.pendingStatus, ais_pending_since: decision.pendingSince },
      db,
    );
  }

  await applyAutomation(
    shipment,
    {
      status: decision.status,
      monitoring_state: decision.monitoring_state,
      reason: decision.reason,
      source: decision.source,
      statusChanged: decision.statusChanged,
      monitoringChanged: decision.monitoringChanged,
    },
    db,
  );
}

/**
 * A purely derived, read-only operational reading of the vessel's current
 * movement — NOT a lifecycle status, never persisted, and never fed back
 * into deriveAisAutomation() or deriveAutomation(). It exists only so the UI
 * can show "Underway" / "Stopped" next to the shipment's actual status.
 *
 * Reuses the exact same isAisFresh() / isUnderway() / isStopped() this
 * module's own decision logic uses, so this can never disagree with what
 * the automation itself considers "fresh" or "under way" — there is only
 * one definition of each, here.
 *
 * "stopped" carries a `context` — In Transit vs Approaching Destination vs
 * other — used only to pick a wording hedge. This is a proxy, not a
 * geographic fact: there are no port coordinates in this schema (see
 * isStopped()'s own comment), so "context" never claims to know whether the
 * vessel is really at the destination.
 */
export type VesselCondition =
  | { kind: "underway" }
  | { kind: "stopped"; context: "in_transit" | "approaching_destination" | "other" }
  | { kind: "unknown" };

export function deriveVesselCondition(
  shipment: Pick<Shipment, "status">,
  position: VesselPosition | null,
  now: number = Date.now(),
): VesselCondition {
  if (!isAisFresh(position, now)) return { kind: "unknown" };
  const fresh = position as VesselPosition;

  if (isUnderway(fresh)) return { kind: "underway" };

  if (isStopped(fresh)) {
    const context =
      shipment.status === "In Transit"
        ? "in_transit"
        : shipment.status === "Approaching Destination"
          ? "approaching_destination"
          : "other";
    return { kind: "stopped", context };
  }

  // Fresh data that is neither clearly under way nor clearly stopped (e.g. a
  // restricted-maneuverability nav status, or SOG between the two
  // thresholds) — there's nothing here strong enough to display without
  // guessing, so this deliberately reports "unknown" rather than picking one.
  return { kind: "unknown" };
}

/**
 * Label for deriveVesselCondition()'s result, or null when nothing should
 * be rendered at all — callers must treat null as "show no badge", not fall
 * back to a default string, so a stale/ambiguous reading never becomes a
 * claim the data can't support.
 */
export function vesselConditionLabel(condition: VesselCondition): string | null {
  switch (condition.kind) {
    case "underway":
      return "Underway";
    case "stopped":
      if (condition.context === "in_transit") return "Stopped · likely intermediate stop";
      if (condition.context === "approaching_destination") return "Stopped · likely destination stop";
      return "Stopped";
    case "unknown":
      return null;
  }
}
