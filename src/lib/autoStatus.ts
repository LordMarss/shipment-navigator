/**
 * Date-based automation (the daily sweep's half of the pipeline).
 *
 * Its job is NOT to infer where a vessel is from the calendar. A planned
 * departure date passing does not mean a vessel sailed (departures slip
 * constantly), and an ETA approaching does not mean it is near port. Guessing
 * from dates is exactly how a shipment ends up reporting the wrong status, so
 * this module never does it.
 *
 * What it does:
 *  - Applies facts an operator has explicitly RECORDED: an `actual_arrival`
 *    (authoritative, unconditional) and a past-dated `actual_departure`
 *    (while monitoring is active). These are deliberate data entry — the
 *    manual-override path expressed as a field — not inference.
 *  - Keeps the monitoring state (Scheduled / Pre-Monitoring / Active) current.
 *  - Explains, in `reason`, when the calendar says something should have
 *    happened but no AIS evidence has arrived — information for the operator,
 *    never a status change. Lifecycle progression from vessel movement is
 *    `deriveAisAutomation()`'s job alone, and it needs fresh AIS to act.
 *
 * Rules that must hold:
 *  - Nothing runs before the shipment's monitoring window opens.
 *  - Nothing runs once a shipment holds a legacy status retired from the
 *    active MVP lifecycle (At Port / Cleared Customs / Delivered).
 *  - Status only ever moves forward; a manual status is never rolled back.
 *  - Every automated move is recorded as its own event (history is append-only).
 */
import {
  ACTIVE_STATUSES,
  isLegacyStatus,
  type ActiveShipmentStatus,
  type MonitoringState,
  type Shipment,
  type ShipmentStatus,
  type EventSource,
} from "@/lib/api";
import { activeAutomationHold, formatUtcMinute, monitoringInfo, type MonitoringConfig } from "@/lib/lifecycle";

const HOUR = 3_600_000;

/** Inside this many hours of the ETA, the shipment is *flagged* as due to approach — never advanced. */
export const APPROACHING_WITHIN_HOURS = 48;

const rank = (status: ActiveShipmentStatus) => ACTIVE_STATUSES.indexOf(status);

/**
 * Whether automation can currently make progress on a shipment, for anyone
 * reading the explanation (no UI change — it is carried in `reason`):
 *  active                 monitoring is open and nothing is missing
 *  insufficient_evidence  monitoring is open but automation is waiting on, or
 *                         cannot use, evidence (unlinked port, no MMSI, overdue
 *                         with no AIS)
 *  paused                 an operator correction has automation on hold
 *  dormant                monitoring has not opened (or has completed)
 */
export type AutomationState = "active" | "insufficient_evidence" | "paused" | "dormant";

export type AutoDecision = {
  status: ShipmentStatus;
  monitoring_state: MonitoringState;
  reason: string;
  /** Why the monitoring state changed, when it did (never a lifecycle/evidence explanation). */
  monitoringReason: string;
  source: EventSource;
  /** True when the stored record differs from the derived values. */
  statusChanged: boolean;
  monitoringChanged: boolean;
  /** Timestamp of the operator-recorded fact behind a status change — the identity of the logical transition. */
  evidenceAt: string | null;
  automation: AutomationState;
};

const FRESH_AIS_REASON = "Fresh AIS data available — deferring lifecycle decisions to AIS automation";

/**
 * What the calendar implies should have happened by now, phrased as a
 * message for the operator. Returns null when nothing is overdue.
 */
function overdueNote(shipment: Shipment, status: ActiveShipmentStatus, now: number): string | null {
  if (status === "Scheduled" || status === "Booked") {
    if (shipment.planned_etd && new Date(shipment.planned_etd).getTime() <= now) {
      return shipment.vessel_mmsi
        ? "Planned departure has passed but no AIS departure evidence has been received"
        : "Planned departure has passed and no vessel MMSI is linked, so departure cannot be detected automatically";
    }
    return null;
  }

  const eta = shipment.eta ?? shipment.planned_eta;
  if (!eta || status === "Arrived") return null;
  const hoursToEta = (new Date(eta).getTime() - now) / HOUR;
  if (status === "Approaching Destination") {
    return hoursToEta < 0 ? "ETA has passed but no AIS arrival evidence has been received" : null;
  }
  // Departed / In Transit
  return hoursToEta <= APPROACHING_WITHIN_HOURS
    ? `ETA is within ${APPROACHING_WITHIN_HOURS}h but no AIS approach evidence has been received`
    : null;
}

/**
 * What is missing for AIS to be able to make the NEXT transition for this
 * shipment. Deterministic from the shipment's own fields, so it can be shown
 * without a live position.
 */
function limitationNotes(shipment: Shipment, status: ActiveShipmentStatus): string[] {
  if (!shipment.vessel_mmsi) return ["No vessel MMSI linked — AIS cannot track this shipment"];
  switch (status) {
    case "Scheduled":
    case "Booked":
      return shipment.origin_port_id ? [] : ["Origin port not linked — AIS cannot confirm departure"];
    case "In Transit":
      return shipment.destination_port_id
        ? []
        : ["Destination port not linked — AIS cannot confirm the vessel is approaching it"];
    case "Approaching Destination":
      return shipment.destination_port_id ? [] : ["Destination port not linked — AIS cannot confirm arrival"];
    default:
      return [];
  }
}

/**
 * Derives the status and monitoring state a shipment should currently be in.
 * Pure — safe to call on every render.
 *
 * `hasFreshAis` is computed by the caller (via `isAisFreshForLifecycle()` in
 * aisAutomation.ts) so this module keeps its one-way dependency shape
 * (aisAutomation.ts depends on autoStatus.ts, not the reverse). It no longer
 * gates any status change — no date-based rule advances status any more — and
 * only selects which explanation is shown.
 */
export function deriveAutomation(
  shipment: Shipment,
  config: MonitoringConfig,
  hasFreshAis: boolean = false,
  now: number = Date.now(),
): AutoDecision {
  const monitoring = monitoringInfo(shipment, config, now);
  // Date-based automation receives no live AIS data, so any move it makes
  // (only ever from operator-recorded facts) is attributed to the system.
  const source: EventSource = "system";

  // Statuses retired from the active MVP lifecycle are frozen: automation
  // never advances (or ranks) a legacy terminal status.
  if (isLegacyStatus(shipment.status)) {
    return {
      status: shipment.status,
      monitoring_state: monitoring.state,
      reason: monitoring.reason,
      monitoringReason: monitoring.reason,
      source,
      statusChanged: false,
      monitoringChanged: monitoring.state !== shipment.monitoring_state,
      evidenceAt: null,
      automation: "dormant",
    };
  }

  let status = shipment.status as ActiveShipmentStatus;
  let reason = monitoring.reason;
  let evidenceAt: string | null = null;
  let automation: AutomationState = monitoring.state === "Active Monitoring" ? "active" : "dormant";

  const hold = activeAutomationHold(shipment, now);
  const advanceTo = (target: ActiveShipmentStatus, why: string, evidence: string | null) => {
    if (rank(target) > rank(status)) {
      status = target;
      reason = why;
      evidenceAt = evidence;
    }
  };

  // While an operator's correction has automation on hold, nothing advances —
  // not even a recorded fact — until the hold ends or is lifted.
  if (hold) {
    automation = "paused";
    reason = `${monitoring.reason} — Automation paused after a manual status correction until ${formatUtcMinute(hold)}; it resumes then, or when an operator resumes it`;
  } else if (shipment.actual_arrival) {
    advanceTo("Arrived", "Actual arrival recorded", shipment.actual_arrival);
  } else if (monitoring.state === "Active Monitoring") {
    const recordedDeparture = shipment.actual_departure ? new Date(shipment.actual_departure).getTime() : null;
    if (recordedDeparture !== null && recordedDeparture <= now) {
      advanceTo("Departed", "Actual departure recorded — vessel has sailed", shipment.actual_departure);
    }
  }

  if (!hold && status === shipment.status && monitoring.state === "Active Monitoring") {
    const notes = limitationNotes(shipment, status);
    const overdue = hasFreshAis ? null : overdueNote(shipment, status, now);
    if (overdue) {
      // With no MMSI the overdue note already explains it — don't say it twice.
      if (!shipment.vessel_mmsi) notes.length = 0;
      notes.push(overdue);
    }
    if (notes.length > 0) {
      automation = "insufficient_evidence";
      reason = `${monitoring.reason} — ${notes.join("; ")}`;
    } else if (hasFreshAis) {
      reason = FRESH_AIS_REASON;
    }
  }

  return {
    status,
    monitoring_state: monitoring.state,
    reason,
    monitoringReason: monitoring.reason,
    source,
    statusChanged: status !== shipment.status,
    monitoringChanged: monitoring.state !== shipment.monitoring_state,
    evidenceAt,
    automation,
  };
}

/** Automation is dormant outside the monitoring window and once a shipment leaves the active lifecycle. */
export function automationActive(shipment: Shipment, config: MonitoringConfig) {
  if (isLegacyStatus(shipment.status) || shipment.actual_delivery) return false;
  const state = monitoringInfo(shipment, config).state;
  return state === "Active Monitoring";
}
