/**
 * Basic automated status pipeline (MVP).
 *
 * Everything here is derived from data already stored on the shipment: the
 * planned / current / actual timestamps and the vessel MMSI used by the
 * MarineTraffic integration. No live AIS polling, no predictive logic.
 *
 * Rules that must hold:
 *  - Nothing runs before the shipment's monitoring window opens.
 *  - Nothing runs once a shipment reaches "Arrived" or holds a legacy status
 *    retired from the active MVP lifecycle (At Port / Cleared Customs /
 *    Delivered) — those are frozen, never advanced.
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
import { monitoringInfo, type MonitoringConfig } from "@/lib/lifecycle";

const HOUR = 3_600_000;

/** A shipment is treated as "in transit" this long after departure. */
export const IN_TRANSIT_AFTER_HOURS = 24;
/** Arrival window: inside this many hours of the ETA the vessel is approaching. */
export const APPROACHING_WITHIN_HOURS = 48;

const rank = (status: ActiveShipmentStatus) => ACTIVE_STATUSES.indexOf(status);

export type AutoDecision = {
  status: ShipmentStatus;
  monitoring_state: MonitoringState;
  reason: string;
  source: EventSource;
  /** True when the stored record differs from the derived values. */
  statusChanged: boolean;
  monitoringChanged: boolean;
};

/**
 * Derives the status and monitoring state a shipment should currently be in.
 * Pure — safe to call on every render.
 *
 * `hasFreshAis` is computed by the caller (via `isAisFresh()` from
 * aisAutomation.ts, applied to that shipment's latest `vessel_positions`
 * row) rather than imported here directly, so this module keeps its
 * existing one-way dependency shape (aisAutomation.ts depends on
 * autoStatus.ts, not the reverse) instead of introducing a cycle. When
 * true, the elapsed-time advances below are skipped entirely: fresh AIS
 * data makes `deriveAisAutomation()` authoritative for further lifecycle
 * progression, so this fallback pipeline must not also advance the status
 * from an assumption AIS could actively be contradicting (e.g. "in transit
 * because enough time passed" while AIS shows the vessel stopped).
 */
export function deriveAutomation(
  shipment: Shipment,
  config: MonitoringConfig,
  hasFreshAis: boolean = false,
  now: number = Date.now(),
): AutoDecision {
  const monitoring = monitoringInfo(shipment, config);
  // This MVP pipeline is date/time based only — it receives no live AIS data,
  // so every automated move is attributed to the system, never to AIS.
  const source: EventSource = "system";

  // Statuses retired from the active MVP lifecycle are frozen: automation
  // never advances (or ranks) a legacy terminal status.
  if (isLegacyStatus(shipment.status)) {
    return {
      status: shipment.status,
      monitoring_state: monitoring.state,
      reason: monitoring.reason,
      source,
      statusChanged: false,
      monitoringChanged: monitoring.state !== shipment.monitoring_state,
    };
  }

  let status = shipment.status as ActiveShipmentStatus;
  let reason = monitoring.reason;

  const advanceTo = (target: ActiveShipmentStatus, why: string) => {
    if (rank(target) > rank(status)) {
      status = target;
      reason = why;
    }
  };

  if (shipment.actual_arrival) {
    advanceTo("Arrived", "Actual arrival recorded");
  } else if (hasFreshAis) {
    // Fresh AIS data exists for this shipment's vessel — deriveAisAutomation()
    // is authoritative for further lifecycle progression, so none of the
    // elapsed-time advances below run. Status is left exactly as stored;
    // only AIS moves it from here.
    reason = "Fresh AIS data available — deferring lifecycle decisions to AIS automation";
  } else if (monitoring.state === "Active Monitoring") {
    // Departure: an actual departure, or the planned departure having passed.
    const plannedEtdPassed =
      shipment.planned_etd && new Date(shipment.planned_etd).getTime() <= now
        ? shipment.planned_etd
        : null;
    const departedAt = shipment.actual_departure ?? plannedEtdPassed;

    if (departedAt) {
      advanceTo(
        "Departed",
        shipment.actual_departure
          ? "Actual departure recorded — vessel has sailed"
          : "Planned departure has passed — vessel treated as sailed",
      );

      const hoursSinceDeparture = (now - new Date(departedAt).getTime()) / HOUR;
      if (hoursSinceDeparture >= IN_TRANSIT_AFTER_HOURS) {
        advanceTo("In Transit", "Vessel under way since departure");
      }

      const eta = shipment.eta ?? shipment.planned_eta;
      if (eta) {
        const hoursToEta = (new Date(eta).getTime() - now) / HOUR;
        if (hoursToEta <= APPROACHING_WITHIN_HOURS) {
          advanceTo(
            "Approaching Destination",
            `Within ${APPROACHING_WITHIN_HOURS}h of the current ETA`,
          );
        }
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
  };
}

/** Automation is dormant outside the monitoring window and once a shipment leaves the active lifecycle. */
export function automationActive(shipment: Shipment, config: MonitoringConfig) {
  if (isLegacyStatus(shipment.status) || shipment.actual_delivery) return false;
  const state = monitoringInfo(shipment, config).state;
  return state === "Active Monitoring";
}
