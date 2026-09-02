/**
 * Shipment lifecycle intelligence.
 *
 * Two orthogonal concepts, deliberately never merged:
 *   STATUS  — where the shipment is in its lifecycle (stored on the record).
 *   HEALTH  — how well it is progressing (stored on the record, and derivable
 *             from the planned / current / actual timestamps when the backend
 *             has not written a value yet).
 *
 * MONITORING STATE describes when the shipment becomes relevant to monitor.
 * A vessel MMSI alone never means a shipment is being monitored: relevance is
 * driven by the planned departure date and a configurable offset.
 *
 * Nothing here invents live vessel data. Every value is derived from what is
 * stored in the database, so a backend job can later own these fields.
 */
import {
  STANDARD_DOCUMENTS,
  type Shipment,
  type ShipmentDocument,
  type ShipmentEvent,
  type Alert,
  type MonitoringState,
} from "@/lib/api";

export type { MonitoringState };

export type HealthLevel = "On Track" | "Attention" | "At Risk" | "Delayed" | "Delivered";

export type Health = {
  level: HealthLevel;
  reason: string;
  action?: string;
};

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Workspace configuration keys stored in `app_settings`. */
export type MonitoringConfig = {
  monitoring_start_offset_days: number;
  pre_monitoring_window_days: number;
  eta_attention_hours: number;
  eta_risk_hours: number;
};

/** Fallback used only until `app_settings` has loaded. Never hard-code inline. */
export const DEFAULT_MONITORING_CONFIG: MonitoringConfig = {
  monitoring_start_offset_days: 7,
  pre_monitoring_window_days: 3,
  eta_attention_hours: 6,
  eta_risk_hours: 24,
};

/* ------------------------------------------------------------------ time --- */

export function toDate(value: string | null | undefined) {
  return value ? new Date(value) : null;
}

export function formatDay(value: string | null | undefined) {
  const d = toDate(value);
  if (!d) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function formatDayTime(value: string | null | undefined) {
  const d = toDate(value);
  if (!d) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function relativeTime(value: string) {
  const diff = Date.now() - new Date(value).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function daysUntil(value: string | null | undefined) {
  const d = toDate(value);
  if (!d) return null;
  return Math.ceil((d.getTime() - Date.now()) / DAY);
}

export function countdownLabel(value: string | null | undefined) {
  const days = daysUntil(value);
  if (days == null) return "—";
  if (days === 0) return "today";
  if (days === 1) return "in 1 day";
  if (days > 1) return `in ${days} days`;
  if (days === -1) return "1 day ago";
  return `${Math.abs(days)} days ago`;
}

/** Difference between a current/actual value and the originally planned one. */
export function drift(planned: string | null | undefined, current: string | null | undefined) {
  const p = toDate(planned);
  const c = toDate(current);
  if (!p || !c) return null;
  const hours = Math.round((c.getTime() - p.getTime()) / HOUR);
  if (hours === 0) return { hours: 0, label: "on original estimate", tone: "neutral" as const };
  const late = hours > 0;
  const abs = Math.abs(hours);
  const magnitude = abs >= 48 ? `${Math.round(abs / 24)} days` : `${abs} hours`;
  return {
    hours,
    label: `${late ? "+" : "−"}${magnitude} ${late ? "later than" : "ahead of"} original estimate`,
    tone: late ? ("late" as const) : ("early" as const),
  };
}

/* ------------------------------------------------------------ monitoring --- */

export function monitoringOffset(shipment: Shipment, config: MonitoringConfig) {
  return shipment.monitoring_start_offset_days ?? config.monitoring_start_offset_days;
}

/** The date active monitoring should begin, derived from planned departure. */
export function monitoringStartDate(shipment: Shipment, config: MonitoringConfig) {
  const etd = toDate(shipment.planned_etd);
  if (!etd) return null;
  return new Date(etd.getTime() - monitoringOffset(shipment, config) * DAY);
}

export type MonitoringInfo = {
  state: MonitoringState;
  /** Stored state when it differs from the derived one. */
  storedState: MonitoringState;
  startsAt: Date | null;
  daysUntilMonitoring: number | null;
  reason: string;
};

/**
 * Derives the monitoring state from planned departure + configurable offset.
 * The backend owns `monitoring_state`; this is what the UI expects it to be.
 */
export function monitoringInfo(shipment: Shipment, config: MonitoringConfig): MonitoringInfo {
  const storedState = (shipment.monitoring_state as MonitoringState) ?? "Scheduled";

  if (shipment.status === "Delivered" || shipment.actual_delivery) {
    return {
      state: "Completed",
      storedState,
      startsAt: null,
      daysUntilMonitoring: null,
      reason: "Shipment completed — active monitoring has stopped",
    };
  }

  if (shipment.actual_departure) {
    return {
      state: "Active Monitoring",
      storedState,
      startsAt: toDate(shipment.actual_departure),
      daysUntilMonitoring: 0,
      reason: "Vessel has departed — shipment is under active monitoring",
    };
  }

  const startsAt = monitoringStartDate(shipment, config);
  if (!startsAt) {
    return {
      state: storedState,
      storedState,
      startsAt: null,
      daysUntilMonitoring: null,
      reason: "No planned departure recorded — the monitoring window cannot be scheduled",
    };
  }

  const days = Math.ceil((startsAt.getTime() - Date.now()) / DAY);
  if (days <= 0) {
    return {
      state: "Active Monitoring",
      storedState,
      startsAt,
      daysUntilMonitoring: 0,
      reason: "Inside the monitoring window for the planned departure",
    };
  }
  if (days <= config.pre_monitoring_window_days) {
    return {
      state: "Pre-Monitoring",
      storedState,
      startsAt,
      daysUntilMonitoring: days,
      reason: `Approaching the monitoring window — begins in ${days} day${days === 1 ? "" : "s"}`,
    };
  }
  return {
    state: "Scheduled",
    storedState,
    startsAt,
    daysUntilMonitoring: days,
    reason: `Departure is far out — monitoring begins ${formatDay(startsAt.toISOString())}`,
  };
}

/* ---------------------------------------------------------------- health --- */

export function docsFor(documents: ShipmentDocument[], shipmentId: string) {
  const standard = documents.filter((d) => d.shipment_id === shipmentId && d.is_standard);
  const attached = standard.filter((d) => d.file_path).length;
  return { attached, total: standard.length || STANDARD_DOCUMENTS.length };
}

/**
 * Health derived from planned vs current vs actual timestamps, documents and
 * status. Independent of `status`, which only says where the shipment is.
 */
export function shipmentHealth(
  shipment: Shipment,
  docs?: { attached: number; total: number },
  config: MonitoringConfig = DEFAULT_MONITORING_CONFIG,
): Health {
  if (shipment.status === "Delivered" || shipment.actual_delivery) {
    return { level: "Delivered", reason: "Delivered — nothing outstanding" };
  }

  // Current ETA slipped against the original plan.
  const etaDrift = drift(shipment.planned_eta ?? shipment.previous_eta, shipment.eta);
  if (etaDrift && etaDrift.hours >= config.eta_risk_hours) {
    return {
      level: "At Risk",
      reason: `Current ETA is ${etaDrift.hours} hours later than the original ETA`,
      action: "Notify the client of the revised arrival window",
    };
  }

  // Departure did not happen when planned.
  const depDrift = drift(shipment.planned_etd, shipment.actual_departure);
  if (depDrift && depDrift.hours >= config.eta_attention_hours) {
    return {
      level: "Delayed",
      reason: `Actual departure occurred ${depDrift.hours} hours later than planned`,
      action: "Recalculate the arrival window with the carrier",
    };
  }

  if (
    shipment.planned_etd &&
    !shipment.actual_departure &&
    new Date(shipment.planned_etd).getTime() < Date.now()
  ) {
    return {
      level: "Delayed",
      reason: `Planned departure of ${formatDay(shipment.planned_etd)} has passed with no recorded departure`,
      action: "Confirm the vessel has sailed and record the actual departure",
    };
  }

  const currentEta = toDate(shipment.eta);
  if (currentEta && !shipment.actual_arrival && currentEta.getTime() < Date.now()) {
    return {
      level: "At Risk",
      reason: `ETA of ${formatDay(shipment.eta)} has passed and the shipment is still ${shipment.status}`,
      action: "Confirm vessel position and record the arrival",
    };
  }

  if (etaDrift && etaDrift.hours >= config.eta_attention_hours) {
    return {
      level: "Attention",
      reason: `Current ETA is ${etaDrift.hours} hours later than the original ETA`,
      action: "Review the revised arrival window",
    };
  }

  if (docs && docs.attached < docs.total) {
    const missing = docs.total - docs.attached;
    const urgent = shipment.status === "At Port" || shipment.status === "Cleared Customs";
    return {
      level: urgent ? "At Risk" : "Attention",
      reason: `${missing} of ${docs.total} required document${missing === 1 ? "" : "s"} still missing`,
      action: urgent
        ? "Upload documents before customs release"
        : "Collect the outstanding documents",
    };
  }

  if (!shipment.planned_eta && !shipment.eta) {
    return {
      level: "Attention",
      reason: "No planned arrival recorded for this shipment",
      action: "Add the planned arrival date",
    };
  }

  if (!shipment.vessel_mmsi) {
    return {
      level: "Attention",
      reason: "No vessel MMSI — this shipment cannot be monitored against AIS data",
      action: "Add the vessel MMSI to enable monitoring",
    };
  }

  return { level: "On Track", reason: `On schedule for ${formatDay(shipment.eta)}` };
}

/* -------------------------------------------------------------- timeline --- */

export type TimelineKind = "planned" | "actual" | "current" | "pending";

export type TimelineEntry = {
  key: string;
  label: string;
  value: string | null;
  kind: TimelineKind;
  complete: boolean;
  delayed?: boolean;
  note?: string;
  source?: string;
  automated?: boolean;
};

/**
 * Builds the lifecycle timeline strictly from stored values. Events that have
 * not happened stay "Pending" — nothing is invented.
 */
export function buildTimeline(shipment: Shipment, events: ShipmentEvent[] = []): TimelineEntry[] {
  const sourceFor = (type: string) => events.find((e) => e.event_type === type);

  const entry = (
    key: string,
    label: string,
    value: string | null,
    kind: TimelineKind,
    extra: Partial<TimelineEntry> = {},
  ): TimelineEntry => {
    const ev = sourceFor(key);
    return {
      key,
      label,
      value,
      kind,
      complete: Boolean(value) && (kind === "actual" || kind === "current"),
      source: ev?.source,
      automated: ev?.automated,
      ...extra,
    };
  };

  const depDrift = drift(shipment.planned_etd, shipment.actual_departure);
  const etaDrift = drift(shipment.planned_eta, shipment.eta);
  const arrDrift = drift(shipment.planned_eta, shipment.actual_arrival);

  const statusIndexReached = (label: string) =>
    ["Departed", "In Transit", "Approaching Destination", "Arrived", "At Port", "Cleared Customs", "Delivered"].includes(
      label,
    );

  const timeline: TimelineEntry[] = [
    { ...entry("created", "Shipment Created", shipment.created_at, "actual"), complete: true },
    entry("planned_etd", "Planned Departure (ETD)", shipment.planned_etd, "planned", {
      complete: Boolean(shipment.actual_departure),
    }),
    entry("actual_departure", "Actual Departure", shipment.actual_departure, "actual", {
      delayed: (depDrift?.hours ?? 0) > 0,
      note: depDrift?.label,
    }),
    {
      key: "in_transit",
      label: "In Transit",
      value: shipment.actual_departure,
      kind: "actual",
      complete: statusIndexReached(shipment.status) && shipment.status !== "Departed",
    },
    entry("planned_eta", "Planned Arrival (ETA)", shipment.planned_eta, "planned"),
    entry("current_eta", "Current ETA", shipment.eta, "current", {
      complete: Boolean(shipment.eta),
      delayed: (etaDrift?.hours ?? 0) > 0,
      note: etaDrift?.label,
    }),
    entry("actual_arrival", "Actual Arrival", shipment.actual_arrival, "actual", {
      delayed: (arrDrift?.hours ?? 0) > 0,
      note: arrDrift?.label,
    }),
    entry("actual_delivery", "Delivered", shipment.actual_delivery, "actual"),
  ];

  return timeline;
}

/* ------------------------------------------------------------------ kpis --- */

export function kpis(
  shipments: Shipment[],
  documents: ShipmentDocument[],
  config: MonitoringConfig = DEFAULT_MONITORING_CONFIG,
) {
  const active = shipments.filter((s) => s.status !== "Delivered");
  let atRisk = 0;
  let onTime = 0;
  let delayed = 0;
  let monitoring = 0;
  for (const s of active) {
    const h = shipmentHealth(s, docsFor(documents, s.id), config);
    if (h.level === "At Risk") atRisk += 1;
    if (h.level === "Delayed") delayed += 1;
    if (h.level === "On Track") onTime += 1;
    if (monitoringInfo(s, config).state === "Active Monitoring") monitoring += 1;
  }
  const totalCost = shipments.reduce((sum, s) => sum + (s.landed_cost ?? 0), 0);
  return {
    active: active.length,
    atRisk,
    delayed,
    onTime,
    monitoring,
    onTimeRate: active.length ? Math.round((onTime / active.length) * 100) : 0,
    delivered: shipments.length - active.length,
    totalCost,
  };
}

/* ---------------------------------------------------------------- alerts --- */

export type Severity = "critical" | "attention" | "informational";

export function alertSeverity(alert: Alert): Severity {
  const m = alert.message.toLowerCase();
  if (m.includes("eta changed") || m.includes("hold") || m.includes("delay")) return "critical";
  if (alert.to_status === "At Port" || m.includes("eta set")) return "attention";
  return "informational";
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "Critical",
  attention: "Attention",
  informational: "Informational",
};
