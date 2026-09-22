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
 * AIS is only trusted for the transitions it can actually observe, and each
 * one needs CURRENT evidence (a position no older than
 * `ais_lifecycle_fresh_minutes`, default 30 — not the 24 h "last known"
 * display window) plus, where a claim is about a place, a place to check
 * against:
 *   Booked -> Departed               vessel under way, heading away, and
 *                                    inside the origin port's departure
 *                                    area (stored radius .. 4x radius) —
 *                                    REQUIRES a linked origin port
 *   Departed -> In Transit           vessel under way and beyond the
 *                                    departure area (4x origin radius);
 *                                    without an origin port, still under way
 *   In Transit -> Approaching Dest.  within 10x the destination's stored
 *                                    radius — REQUIRES a linked destination
 *                                    port; an ETA alone is never enough
 *   Approaching Dest. -> Arrived     stopped (nav status anchored/moored AND
 *                                    a known SOG <= 0.5 kn) inside the
 *                                    destination's stored radius — REQUIRES
 *                                    a linked destination port
 * Scheduled -> Booked is a booking/paperwork milestone, not an AIS-observable
 * event, so AIS never touches it. An actual arrival timestamp (recorded by
 * whatever process sets it) is authoritative and bypasses AIS entirely, same
 * as the date-based automation. When the data needed to make a claim is
 * missing (no port, no course, no speed) the answer is "not enough evidence
 * yet" — never a guess.
 *
 * Flap prevention: since only the *latest* position is persisted (no AIS
 * history), "consecutive qualifying observations" is implemented with two
 * tiny persisted columns (`ais_pending_status` / `ais_pending_since`) — a
 * candidate must be observed again, by a DISTINCT later position report at
 * least AIS_CONFIRMATION_MINUTES after the first, before it is promoted to
 * the shipment's real status. `ais_pending_since` holds the first
 * observation's position timestamp (AIS time, not evaluation time), so a
 * replayed or duplicated report of the same position can never stand in for
 * the second observation, however much later it is delivered. A candidate
 * that no longer matches what the current status would need next (e.g. a
 * manual status change moved past it) is naturally superseded on the next
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
  type ActiveShipmentStatus,
  type AutomationOutcome,
  type Db,
  type EventSource,
  type MonitoringState,
  type Port,
  type Shipment,
  type ShipmentStatus,
  type VesselPosition,
} from "@/lib/api";
import { supabase } from "@/integrations/supabase/client";
import { angularDifferenceDeg, haversineDistanceKm, initialBearingDeg } from "@/lib/geo";
import {
  DEFAULT_MONITORING_CONFIG,
  activeAutomationHold,
  formatUtcMinute,
  monitoringInfo,
  type MonitoringConfig,
} from "@/lib/lifecycle";

const HOUR = 3_600_000;
const MINUTE = 60_000;
/**
 * How much wider than the destination's own geofence counts as "getting
 * close" for the Approaching Destination signal. Applied to the destination
 * port's STORED radius, and only with a linked destination port and a fresh
 * position — there is no ETA-only path to Approaching Destination.
 */
export const APPROACH_RADIUS_MULTIPLIER = 10;
/**
 * The origin port's "departure area" as a multiple of its stored radius.
 * Inside the radius the vessel is still in port (berth shifting, harbour
 * manoeuvring). From the radius out to this multiple it is leaving the port
 * area — the only place a movement can be attributed to THIS shipment's
 * departure. Beyond it the vessel is either already on the voyage (evidence
 * for In Transit) or, before the voyage began, a vessel that was never at
 * this origin (evidence of nothing). Deliberately modest: a hundred-odd
 * kilometres at most, not "anywhere in the region".
 */
export const DEPARTURE_AREA_MULTIPLIER = 4;
/** A departing vessel must be heading within this many degrees of directly away from the origin port. */
export const MAX_DEPARTURE_BEARING_DIFF_DEG = 90;

/**
 * Beyond this age a position is only "last known" information — what the UI
 * shows as history — never evidence for a lifecycle decision. See
 * `AIS_LIFECYCLE_FRESH_MINUTES` for the (much tighter) evidence window.
 */
export const AIS_STALE_HOURS = 24;
/**
 * Default age limit, in minutes, for a position to count as evidence for a
 * lifecycle decision. Configurable per workspace via
 * `config.ais_lifecycle_fresh_minutes`. Evaluation is event-driven (it runs
 * when a position arrives), so in normal operation the position being judged
 * is seconds old; this bound exists so that a delayed, replayed, or
 * manually-triggered evaluation can never act on yesterday's report.
 */
export const AIS_LIFECYCLE_FRESH_MINUTES = 30;
/** A position timestamped further into the future than this is a clock error, not evidence. */
export const AIS_MAX_FUTURE_SKEW_MINUTES = 5;
/** A candidate must be observed again — by a distinct, later position report — at least this long after it was first proposed. */
export const AIS_CONFIRMATION_MINUTES = 15;
/**
 * A pending candidate whose first observation is older than this (measured
 * in AIS time, between position timestamps) no longer counts as
 * corroboration — it's treated as expired and restarted from the current
 * observation. Without this, a candidate that sat pending for days (e.g. an
 * AIS worker outage, or a vessel out of coverage) would instantly "confirm"
 * on a single fresh reading once AIS_CONFIRMATION_MINUTES had trivially
 * elapsed — the exact single-point flap this debounce exists to prevent.
 */
export const AIS_PENDING_MAX_AGE_MINUTES = 120;
/** At/above this SOG, a vessel is considered moving under its own power (not sitting at berth). */
export const DEPARTURE_MIN_SOG_KNOTS = 2;
/** At/below this SOG (with a stopped nav status), a vessel is considered stopped. */
export const ARRIVAL_MAX_SOG_KNOTS = 0.5;
/** ITU-R M.1371's "speed not available" value (1023 in 0.1 kn units) — never a real speed. */
export const AIS_SOG_NOT_AVAILABLE_KNOTS = 102.3;

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
  /** Why the monitoring state changed, when it did — kept apart from `reason` (the AIS evidence). */
  monitoringReason: string;
  /**
   * Identity of the logical transition, for idempotency: when the evidence
   * behind a status change was FIRST observed (the pending candidate's first
   * position timestamp), or the timestamp of the operator-recorded fact that
   * caused it. Every evaluator that confirms the same candidate agrees on it.
   */
  evidenceAt: string | null;
  /** When AIS confirms Departed / Arrived, the AIS observation time to stamp as actual_departure / actual_arrival. */
  stampActualDeparture: string | null;
  stampActualArrival: string | null;
};

/** Epoch ms of when a position was observed (AIS time), or null if it has no usable timestamp. */
function observedAtMs(position: VesselPosition): number | null {
  const ts = position.position_timestamp ?? position.received_at;
  if (!ts) return null;
  const ms = new Date(ts).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * DISPLAY freshness: is this position recent enough to show as the vessel's
 * "live" reading rather than historical "last known" information (24 h).
 * Used by the UI and the vessel-condition badge — NOT by lifecycle
 * decisions, which use `isAisFreshForLifecycle()`. The latest position is
 * never deleted for being stale; it stays visible as history.
 */
export function isAisFresh(position: VesselPosition | null, now: number): boolean {
  if (!position) return false;
  const ts = position.position_timestamp ?? position.received_at;
  if (!ts) return false;
  const ageHours = (now - new Date(ts).getTime()) / HOUR;
  return ageHours <= AIS_STALE_HOURS;
}

/** The lifecycle evidence window in minutes, from config, falling back to the default for a missing/invalid value. */
function lifecycleFreshMinutes(config: Pick<MonitoringConfig, "ais_lifecycle_fresh_minutes">): number {
  const v = config.ais_lifecycle_fresh_minutes;
  return Number.isFinite(v) && v > 0 ? v : AIS_LIFECYCLE_FRESH_MINUTES;
}

/**
 * LIFECYCLE freshness: is this position current enough to be evidence for a
 * status decision. Stale evidence must not advance a status, confirm a
 * pending candidate, or produce Approaching Destination / Arrived. A
 * timestamp implausibly far in the future (clock error) is not fresh either.
 */
export function isAisFreshForLifecycle(
  position: VesselPosition | null,
  now: number,
  config: Pick<MonitoringConfig, "ais_lifecycle_fresh_minutes"> = DEFAULT_MONITORING_CONFIG,
): boolean {
  if (!position) return false;
  const observed = observedAtMs(position);
  if (observed === null) return false;
  const ageMinutes = (now - observed) / MINUTE;
  return ageMinutes >= -AIS_MAX_FUTURE_SKEW_MINUTES && ageMinutes <= lifecycleFreshMinutes(config);
}

/** SOG in knots, or null when missing, non-finite, negative, or the "not available" sentinel. */
function usableSog(position: VesselPosition): number | null {
  const sog = position.sog;
  if (sog == null || !Number.isFinite(sog) || sog < 0 || sog >= AIS_SOG_NOT_AVAILABLE_KNOTS) return null;
  return sog;
}

/** COG in degrees [0, 360), or null when missing, non-finite, or the "not available" value (360). */
function usableCog(position: VesselPosition): number | null {
  const cog = position.cog;
  if (cog == null || !Number.isFinite(cog) || cog < 0 || cog >= 360) return null;
  return cog;
}

function isUnderway(position: VesselPosition): boolean {
  const sog = usableSog(position);
  if (sog === null || sog < DEPARTURE_MIN_SOG_KNOTS) return false;
  // nav_status is a secondary sanity check, not required — some Class B
  // transponders don't populate it reliably. SOG is the primary signal.
  if (position.nav_status != null && STOPPED_NAV_STATUS.has(position.nav_status)) return false;
  return true;
}

function isStopped(position: VesselPosition): boolean {
  // Conservative on purpose: this is the highest-stakes transition (a false
  // "Arrived" is the worst outcome), so BOTH are required — an explicit
  // stopped nav status (anchored/moored) AND a known SOG at or below
  // ARRIVAL_MAX_SOG_KNOTS. An unknown SOG is insufficient evidence, not
  // "probably stopped": with no speed we cannot say the vessel isn't moving.
  //
  // This only proves the vessel has stopped somewhere. That it stopped at the
  // shipment's destination is a separate, geographic check — which is why
  // Arrived also requires a linked destination port (see evidenceFor()).
  if (position.nav_status == null || !STOPPED_NAV_STATUS.has(position.nav_status)) return false;
  const sog = usableSog(position);
  return sog !== null && sog <= ARRIVAL_MAX_SOG_KNOTS;
}

/** Distance from a position to a port, in kilometers. */
function distanceToPortKm(position: VesselPosition, port: Port): number {
  return haversineDistanceKm(position.latitude, position.longitude, port.latitude, port.longitude);
}

/** Destination-aware "getting close" signal — a wider radius around the same port used for the (stricter) arrival geofence. */
function withinApproachRange(position: VesselPosition, port: Port): boolean {
  return distanceToPortKm(position, port) <= port.geofence_radius_km * APPROACH_RADIUS_MULTIPLIER;
}

type Evidence = { ok: boolean; reason: string };

const NO_FRESH = (what: string): Evidence => ({ ok: false, reason: `No fresh AIS position — cannot confirm ${what}` });

/**
 * Booked -> Departed. "Under way" alone proves nothing about THIS shipment:
 * the vessel may be finishing a previous voyage, repositioning, or shifting
 * berths. So the vessel must be under way, heading away from the origin, and
 * inside the origin port's departure area (its stored radius out to
 * DEPARTURE_AREA_MULTIPLIER x that radius). Without a linked origin port
 * there is no coordinate to measure against, so AIS makes no departure claim
 * at all — a recorded actual_departure or a manual advance still can.
 */
function departureEvidence(position: VesselPosition | null, fresh: boolean, originPort: Port | null): Evidence {
  if (!fresh || !position) return NO_FRESH("departure");
  if (!originPort) {
    return {
      ok: false,
      reason: "Origin port not linked — AIS alone cannot show the vessel departed this shipment's origin",
    };
  }
  if (!isUnderway(position)) {
    return { ok: false, reason: "AIS position received, but the vessel is not yet confirmed under way" };
  }

  const distanceKm = distanceToPortKm(position, originPort);
  const radiusKm = originPort.geofence_radius_km;
  const areaKm = radiusKm * DEPARTURE_AREA_MULTIPLIER;
  if (distanceKm <= radiusKm) {
    return {
      ok: false,
      reason: `Vessel is under way but still inside the ${originPort.name} geofence (${distanceKm.toFixed(1)} km, radius ${radiusKm} km) — harbour movement, not a departure`,
    };
  }
  if (distanceKm > areaKm) {
    return {
      ok: false,
      reason: `Vessel is ${distanceKm.toFixed(1)} km from ${originPort.name} — beyond its ${areaKm} km departure area, so this movement cannot be attributed to this shipment's departure`,
    };
  }

  const cog = usableCog(position);
  if (cog === null) {
    return {
      ok: false,
      reason: "Course over ground unavailable — cannot confirm the vessel is heading away from the origin port",
    };
  }
  const awayBearing = initialBearingDeg(originPort.latitude, originPort.longitude, position.latitude, position.longitude);
  if (angularDifferenceDeg(cog, awayBearing) > MAX_DEPARTURE_BEARING_DIFF_DEG) {
    return {
      ok: false,
      reason: `Vessel is heading toward ${originPort.name}, not away from it (course ${cog.toFixed(0)}°)`,
    };
  }
  return {
    ok: true,
    reason: `AIS shows the vessel under way and heading away from ${originPort.name}, ${distanceKm.toFixed(1)} km out (SOG ${position.sog} kn)`,
  };
}

/**
 * Departed -> In Transit. Not a repeat of the departure test: with an origin
 * port the vessel must also have moved beyond its departure area, so pottering
 * around the terminal/harbour never counts. Without an origin port the
 * shipment already reached Departed by some other route (recorded departure,
 * manual advance), and "still under way" is the only evidence available.
 */
function inTransitEvidence(position: VesselPosition | null, fresh: boolean, originPort: Port | null): Evidence {
  if (!fresh || !position) return { ok: false, reason: "No fresh AIS position since departure" };
  if (!isUnderway(position)) {
    return { ok: false, reason: "AIS position received, but the vessel is no longer confirmed under way" };
  }
  if (!originPort) {
    return { ok: true, reason: `AIS confirms the vessel is still under way (SOG ${position.sog} kn)` };
  }
  const distanceKm = distanceToPortKm(position, originPort);
  const areaKm = originPort.geofence_radius_km * DEPARTURE_AREA_MULTIPLIER;
  if (distanceKm <= areaKm) {
    return {
      ok: false,
      reason: `Vessel is under way but only ${distanceKm.toFixed(1)} km from ${originPort.name} — still within its ${areaKm} km departure area`,
    };
  }
  return {
    ok: true,
    reason: `AIS confirms the vessel is under way, ${distanceKm.toFixed(1)} km from ${originPort.name} (SOG ${position.sog} kn)`,
  };
}

/**
 * In Transit -> Approaching Destination. Geographic evidence only: within
 * APPROACH_RADIUS_MULTIPLIER x the destination's stored radius. An ETA
 * falling inside some window is not evidence about where the vessel is, so it
 * plays no part here — and without a linked destination port there is
 * nothing to measure against, so AIS does not make the claim.
 */
function approachEvidence(position: VesselPosition | null, fresh: boolean, destinationPort: Port | null): Evidence {
  if (!fresh || !position) return NO_FRESH("approach");
  if (!destinationPort) {
    return { ok: false, reason: "Destination port not linked — AIS cannot confirm the vessel is approaching it" };
  }
  const distanceKm = distanceToPortKm(position, destinationPort);
  const rangeKm = destinationPort.geofence_radius_km * APPROACH_RADIUS_MULTIPLIER;
  return withinApproachRange(position, destinationPort)
    ? {
        ok: true,
        reason: `Within range of ${destinationPort.name} (${distanceKm.toFixed(1)} km, approach range ${rangeKm} km) and AIS is still reporting`,
      }
    : {
        ok: false,
        reason: `Not yet within range of ${destinationPort.name} (${distanceKm.toFixed(1)} km away, approach range ${rangeKm} km)`,
      };
}

/**
 * Approaching Destination -> Arrived. Requires a linked destination port (a
 * stop somewhere unidentified could be an intermediate port, an anchorage, a
 * weather hold, bunkering), fresh AIS, a stopped vessel (anchored/moored AND
 * a known SOG <= 0.5 kn), and a position inside the port's stored radius.
 */
function arrivalEvidence(position: VesselPosition | null, fresh: boolean, destinationPort: Port | null): Evidence {
  if (!fresh || !position) return NO_FRESH("arrival");
  if (!destinationPort) {
    return {
      ok: false,
      reason: "Destination port not linked — AIS will not confirm arrival automatically",
    };
  }
  if (!isStopped(position)) {
    return {
      ok: false,
      reason:
        usableSog(position) === null
          ? "Vessel speed unavailable — cannot confirm the vessel is stopped"
          : "AIS position received, but the vessel is not yet confirmed stopped",
    };
  }
  const distanceKm = distanceToPortKm(position, destinationPort);
  const inGeofence = distanceKm <= destinationPort.geofence_radius_km;
  return {
    ok: inGeofence,
    reason: inGeofence
      ? `AIS shows the vessel stopped inside the ${destinationPort.name} geofence (${distanceKm.toFixed(1)} km, radius ${destinationPort.geofence_radius_km} km)`
      : `Vessel is stopped but ${distanceKm.toFixed(1)} km from ${destinationPort.name} — outside its ${destinationPort.geofence_radius_km} km geofence, treated as an intermediate stop`,
  };
}

function evidenceFor(
  nextCandidate: ActiveShipmentStatus,
  position: VesselPosition | null,
  now: number,
  destinationPort: Port | null,
  originPort: Port | null,
  config: MonitoringConfig,
): Evidence {
  const fresh = isAisFreshForLifecycle(position, now, config);
  switch (nextCandidate) {
    case "Departed":
      return departureEvidence(position, fresh, originPort);
    case "In Transit":
      return inTransitEvidence(position, fresh, originPort);
    case "Approaching Destination":
      return approachEvidence(position, fresh, destinationPort);
    case "Arrived":
      return arrivalEvidence(position, fresh, destinationPort);
    default:
      // Scheduled -> Booked: not AIS-observable.
      return { ok: false, reason: "Not an AIS-observable transition" };
  }
}

/**
 * Debounces a candidate against the shipment's persisted pending state,
 * measured in AIS time. `observedMs` is the position's own timestamp, and
 * `ais_pending_since` stores the FIRST qualifying observation's position
 * timestamp — so wall-clock delivery time never counts. Replaying or
 * re-delivering the same report later cannot corroborate itself (elapsed
 * between identical timestamps is zero); only a genuinely later report can.
 */
function confirmCandidate(
  shipment: Shipment,
  candidate: ActiveShipmentStatus,
  evidenceOk: boolean,
  observedMs: number | null,
): { advance: boolean; pendingStatus: ActiveShipmentStatus | null; pendingSince: string | null } {
  if (!evidenceOk || observedMs === null) {
    return { advance: false, pendingStatus: null, pendingSince: null };
  }
  const observedIso = new Date(observedMs).toISOString();

  const storedPending = shipment.ais_pending_status as ActiveShipmentStatus | null;
  const storedSince = shipment.ais_pending_since;

  if (storedPending === candidate && storedSince) {
    const sinceMs = new Date(storedSince).getTime();
    if (!Number.isFinite(sinceMs)) {
      // Unreadable marker — never trust it; start over from this observation.
      return { advance: false, pendingStatus: candidate, pendingSince: observedIso };
    }
    const elapsedMinutes = (observedMs - sinceMs) / MINUTE;
    if (elapsedMinutes < 0) {
      // Older than the observation that started this candidate (out of order,
      // or a replay of something earlier): not corroboration. Leave the
      // pending marker exactly as it is.
      return { advance: false, pendingStatus: candidate, pendingSince: storedSince };
    }
    if (elapsedMinutes > AIS_PENDING_MAX_AGE_MINUTES) {
      // Too old to count as corroboration — restart the debounce window
      // from this fresh observation rather than treating a stale marker
      // plus one new reading as two agreeing observations.
      return { advance: false, pendingStatus: candidate, pendingSince: observedIso };
    }
    if (elapsedMinutes >= AIS_CONFIRMATION_MINUTES) {
      return { advance: true, pendingStatus: null, pendingSince: null };
    }
    return { advance: false, pendingStatus: candidate, pendingSince: storedSince };
  }

  // First qualifying observation for this candidate — or a different
  // candidate was pending before (e.g. a manual change moved the shipment
  // past it), which this naturally supersedes rather than carrying over.
  return { advance: false, pendingStatus: candidate, pendingSince: observedIso };
}

/**
 * Derives the status an AIS-informed evaluation would set. Pure — safe to
 * call repeatedly with the same inputs; only mutates via the returned
 * decision's pending fields, which the caller persists.
 *
 * `originPort` / `destinationPort` are the shipment's linked ports (null when
 * not linked). Both are needed for the claims that are about a place: no
 * origin port -> AIS cannot confirm Departed; no destination port -> AIS
 * cannot confirm Approaching Destination or Arrived. See evidenceFor().
 */
export function deriveAisAutomation(
  shipment: Shipment,
  position: VesselPosition | null,
  config: MonitoringConfig,
  now: number = Date.now(),
  destinationPort: Port | null = null,
  originPort: Port | null = null,
): AisDecision {
  const monitoring = monitoringInfo(shipment, config, now);

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
      monitoringReason: monitoring.reason,
      evidenceAt: null,
      stampActualDeparture: null,
      stampActualArrival: null,
    };
  }

  // An operator has just corrected this shipment: automation stands down. No
  // status change and no pending candidate is accumulated (evidence gathered
  // now must not confirm the instant the hold ends); what is stored is left
  // untouched. The database enforces the same rule as the last line of defence.
  const hold = activeAutomationHold(shipment, now);
  if (hold) {
    return {
      status: shipment.status,
      monitoring_state: monitoring.state,
      reason: `Automation paused after a manual status correction until ${formatUtcMinute(hold)}`,
      source: "system",
      statusChanged: false,
      monitoringChanged: monitoring.state !== shipment.monitoring_state,
      pendingStatus: shipment.ais_pending_status as ActiveShipmentStatus | null,
      pendingSince: shipment.ais_pending_since,
      monitoringReason: monitoring.reason,
      evidenceAt: null,
      stampActualDeparture: null,
      stampActualArrival: null,
    };
  }

  let status = shipment.status as ActiveShipmentStatus;
  let reason = monitoring.reason;
  let source: EventSource = "system";
  let pendingStatus: ActiveShipmentStatus | null = null;
  let pendingSince: string | null = null;
  let evidenceAt: string | null = null;

  // Authoritative and unconditional, same as the existing date-based
  // automation — AIS never needs to (and cannot) override a recorded
  // actual arrival.
  if (shipment.actual_arrival && rank("Arrived") > rank(status)) {
    status = "Arrived";
    reason = "Actual arrival recorded";
    evidenceAt = shipment.actual_arrival;
  } else if (monitoring.state === "Active Monitoring" && status !== "Scheduled") {
    const nextCandidate = ACTIVE_STATUSES[rank(status) + 1] as ActiveShipmentStatus | undefined;

    if (nextCandidate) {
      // The end of an operator hold (expired, or lifted early — resume sets it
      // to that instant) is an evidence boundary: an observation taken at or
      // before it never counts, so nothing gathered during the hold can start,
      // or confirm, a candidate the moment automation is allowed to act again.
      const holdEndMs = shipment.automation_hold_until ? new Date(shipment.automation_hold_until).getTime() : NaN;
      const observedMs = position ? observedAtMs(position) : null;
      const predatesHold = Number.isFinite(holdEndMs) && observedMs !== null && observedMs <= holdEndMs;
      const evidence = predatesHold
        ? {
            ok: false,
            reason: `Waiting for an AIS observation after ${formatUtcMinute(new Date(holdEndMs))} — evidence from before an operator correction is not used`,
          }
        : evidenceFor(nextCandidate, position, now, destinationPort, originPort, config);
      const result = confirmCandidate(shipment, nextCandidate, evidence.ok, observedMs);
      pendingStatus = result.pendingStatus;
      pendingSince = result.pendingSince;
      reason = evidence.reason;

      if (result.advance) {
        status = nextCandidate;
        source = "ais";
        // The candidate's first qualifying observation identifies this logical
        // transition (every concurrent confirmer shares it) and is the AIS
        // moment the milestone actually happened.
        evidenceAt = shipment.ais_pending_since;
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
    monitoringReason: monitoring.reason,
    evidenceAt,
    stampActualDeparture: source === "ais" && status === "Departed" ? evidenceAt : null,
    stampActualArrival: source === "ais" && status === "Arrived" ? evidenceAt : null,
  };
}

/**
 * Persists an AIS-derived decision through `applyAutomation()` — the single,
 * atomic write path shared with the date-based sweep. The pending-candidate
 * update, the status change, its history event and alert, and any actual
 * departure/arrival stamp are committed together or not at all, and only if
 * the shipment is still exactly as this evaluation saw it. Two webhooks
 * racing on the same shipment, or an operator changing it mid-evaluation,
 * therefore cannot produce a duplicate transition or overwrite the newer
 * state: the loser gets a `conflict`/`held`/`duplicate` outcome and writes
 * nothing. The next position report re-evaluates from the real state.
 */
export async function applyAisDecision(
  shipment: Shipment,
  decision: AisDecision,
  db: Db = supabase,
): Promise<AutomationOutcome> {
  return applyAutomation(
    shipment,
    {
      status: decision.status,
      monitoring_state: decision.monitoring_state,
      reason: decision.reason,
      monitoringReason: decision.monitoringReason,
      source: decision.source,
      statusChanged: decision.statusChanged,
      monitoringChanged: decision.monitoringChanged,
      pending: { status: decision.pendingStatus, since: decision.pendingSince },
      evidenceAt: decision.evidenceAt,
      stampActualDeparture: decision.stampActualDeparture,
      stampActualArrival: decision.stampActualArrival,
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
