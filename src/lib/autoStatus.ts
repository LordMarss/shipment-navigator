/**
 * Basic automated status pipeline (MVP).
 *
 * Everything here is derived from data already stored on the shipment: the
 * planned / current / actual timestamps and the vessel MMSI used by the
 * MarineTraffic integration. No live AIS polling, no predictive logic.
 *
 * Rules that must hold:
 *  - Nothing runs before the shipment's monitoring window opens.
 *  - Nothing runs once the shipment is completed (Delivered).
 *  - Status only ever moves forward; a manual status is never rolled back.
 *  - Every automated move is recorded as its own event (history is append-only).
 */
import {
  STATUSES,
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

const rank = (status: string) => STATUSES.indexOf(status as ShipmentStatus);

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
 */
export function deriveAutomation(
  shipment: Shipment,
  config: MonitoringConfig,
  now: number = Date.now(),
): AutoDecision {
  const monitoring = monitoringInfo(shipment, config);
  const source: EventSource = shipment.vessel_mmsi ? "ais" : "system";

  let status = shipment.status as ShipmentStatus;
  let reason = monitoring.reason;

  const advanceTo = (target: ShipmentStatus, why: string) => {
    if (rank(target) > rank(status)) {
      status = target;
      reason = why;
    }
  };

  if (shipment.actual_delivery) {
    advanceTo("Delivered", "Actual delivery recorded");
  } else if (shipment.actual_arrival) {
    advanceTo("Arrived", "Actual arrival recorded");
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

/** Automation is dormant outside the monitoring window and after delivery. */
export function automationActive(shipment: Shipment, config: MonitoringConfig) {
  if (shipment.status === "Delivered" || shipment.actual_delivery) return false;
  const state = monitoringInfo(shipment, config).state;
  return state === "Active Monitoring";
}
