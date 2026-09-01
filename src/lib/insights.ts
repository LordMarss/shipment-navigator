import {
  STANDARD_DOCUMENTS,
  formatEta,
  type Alert,
  type Shipment,
  type ShipmentDocument,
} from "@/lib/api";

export type HealthLevel = "On Track" | "Attention Required" | "At Risk" | "Delivered";

export type Health = {
  level: HealthLevel;
  reason: string;
  action?: string;
};

const HOUR = 3_600_000;

export function docsFor(documents: ShipmentDocument[], shipmentId: string) {
  const standard = documents.filter((d) => d.shipment_id === shipmentId && d.is_standard);
  const attached = standard.filter((d) => d.file_path).length;
  return { attached, total: standard.length || STANDARD_DOCUMENTS.length };
}

/**
 * Health is derived only from data we actually store: status, ETA, previous ETA
 * and attached documents. Nothing is inferred from external sources.
 */
export function shipmentHealth(
  shipment: Shipment,
  docs?: { attached: number; total: number },
): Health {
  if (shipment.status === "Delivered") {
    return { level: "Delivered", reason: "Delivered — nothing outstanding" };
  }

  const now = Date.now();
  const eta = shipment.eta ? new Date(shipment.eta).getTime() : null;

  if (eta !== null && eta < now) {
    return {
      level: "At Risk",
      reason: `ETA of ${formatEta(shipment.eta)} has passed and the shipment is still ${shipment.status}`,
      action: "Confirm vessel position and update the status",
    };
  }

  if (shipment.previous_eta && shipment.eta) {
    const slip = (new Date(shipment.eta).getTime() - new Date(shipment.previous_eta).getTime()) / HOUR;
    if (slip >= 6) {
      return {
        level: "At Risk",
        reason: `ETA slipped ${Math.round(slip)} hours to ${formatEta(shipment.eta)}`,
        action: "Notify the client of the revised arrival window",
      };
    }
  }

  if (docs && docs.attached < docs.total) {
    const missing = docs.total - docs.attached;
    const urgent = shipment.status === "At Port" || shipment.status === "Cleared Customs";
    return {
      level: urgent ? "At Risk" : "Attention Required",
      reason: `${missing} of ${docs.total} required document${missing === 1 ? "" : "s"} still missing`,
      action: urgent ? "Upload documents before customs release" : "Collect the outstanding documents",
    };
  }

  if (!shipment.eta) {
    return {
      level: "Attention Required",
      reason: "No ETA recorded for this shipment",
      action: "Add the expected arrival date",
    };
  }

  if (!shipment.vessel_mmsi) {
    return {
      level: "Attention Required",
      reason: "No vessel MMSI — this shipment cannot be tracked on the fleet map",
      action: "Add the vessel MMSI to enable live tracking",
    };
  }

  return { level: "On Track", reason: `On schedule for ${formatEta(shipment.eta)}` };
}

export function kpis(shipments: Shipment[], documents: ShipmentDocument[]) {
  const active = shipments.filter((s) => s.status !== "Delivered");
  let atRisk = 0;
  let onTime = 0;
  for (const s of active) {
    const h = shipmentHealth(s, docsFor(documents, s.id));
    if (h.level === "At Risk") atRisk += 1;
    if (h.level === "On Track") onTime += 1;
  }
  const totalCost = shipments.reduce((sum, s) => sum + (s.landed_cost ?? 0), 0);
  return {
    active: active.length,
    atRisk,
    onTime,
    onTimeRate: active.length ? Math.round((onTime / active.length) * 100) : 0,
    delivered: shipments.length - active.length,
    totalCost,
  };
}

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

export function relativeTime(value: string) {
  const diff = Date.now() - new Date(value).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
