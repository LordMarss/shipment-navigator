import { Anchor, BookmarkCheck, CalendarClock, CheckCircle2, MapPin, Ship, type LucideIcon } from "lucide-react";

import type { VesselCondition } from "@/lib/aisAutomation";
import type { ShipmentStatus } from "@/lib/api";
import type { HealthLevel, MonitoringState, Severity } from "@/lib/lifecycle";

/**
 * One consistent meaning per phase, not a different colour per stage:
 * Scheduled/Booked (not yet moving) — neutral.
 * Departed / In Transit / Approaching Destination (all underway) — the
 * same restrained blue; the icon (anchor / ship / pin) is what tells
 * these apart, not the colour.
 * Arrived (success) — green. At Port (needs follow-up) — amber.
 *
 * Colour is carried by exactly one signal — the dot — everywhere this
 * status appears; the label text always stays ink, so a row never shows
 * three simultaneous colour cues (border + background + text) for the
 * same fact.
 */
const DOT: Record<ShipmentStatus, string> = {
  Scheduled: "bg-muted-foreground/50",
  Booked: "bg-muted-foreground/50",
  Departed: "bg-primary",
  "In Transit": "bg-primary",
  "Approaching Destination": "bg-primary",
  Arrived: "bg-positive",
  "At Port": "bg-warning",
  "Cleared Customs": "bg-positive",
  Delivered: "bg-positive",
};

export type StatusAccent = "neutral" | "primary" | "positive" | "warning";

/** Which accent family a status belongs to — shared so the lifecycle
 * stepper and change history on the shipment detail page use exactly the
 * same colour-to-status mapping as StatusPill itself. */
export function statusAccent(status: ShipmentStatus): StatusAccent {
  switch (status) {
    case "Departed":
    case "In Transit":
    case "Approaching Destination":
      return "primary";
    case "Arrived":
    case "Cleared Customs":
    case "Delivered":
      return "positive";
    case "At Port":
      return "warning";
    default:
      return "neutral";
  }
}

const STATUS_ICON: Partial<Record<ShipmentStatus, LucideIcon>> = {
  Scheduled: CalendarClock,
  Booked: BookmarkCheck,
  Departed: Anchor,
  "In Transit": Ship,
  "Approaching Destination": MapPin,
  Arrived: CheckCircle2,
};

/** `size="lg"` renders a quiet bordered chip with a status icon (used for
 * a page's primary status display); `sm` (default) is plain text with a
 * coloured dot — no pill shape, so a table full of these reads as data,
 * not a row of badges. Same colour tokens either way. */
export function StatusPill({
  status,
  size = "sm",
}: {
  status: ShipmentStatus;
  size?: "sm" | "lg";
}) {
  if (size === "lg") {
    const Icon = STATUS_ICON[status];
    return (
      <span className="inline-flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm font-medium whitespace-nowrap text-foreground">
        {Icon ? (
          <Icon className="size-3.5 text-muted-foreground" aria-hidden />
        ) : (
          <span className={`size-1.5 rounded-full ${DOT[status] ?? DOT.Booked}`} aria-hidden />
        )}
        {status}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm text-foreground">
      <span className={`size-1.5 shrink-0 rounded-full ${DOT[status] ?? DOT.Booked}`} aria-hidden />
      {status}
    </span>
  );
}

const HEALTH_DOT: Record<HealthLevel, string> = {
  "On Track": "bg-positive",
  Attention: "bg-warning",
  "At Risk": "bg-risk",
  Delayed: "bg-risk",
  Delivered: "bg-muted-foreground/50",
};

export function HealthBadge({ level }: { level: HealthLevel }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm text-foreground">
      <span className={`size-1.5 rounded-full ${HEALTH_DOT[level]}`} aria-hidden />
      {level}
    </span>
  );
}

const MONITORING_DOT: Record<MonitoringState, string> = {
  Scheduled: "bg-muted-foreground/50",
  "Pre-Monitoring": "bg-warning",
  "Active Monitoring": "bg-primary",
  Completed: "bg-positive",
};

export function MonitoringBadge({ state }: { state: MonitoringState }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm text-foreground">
      <span className={`size-1.5 rounded-full ${MONITORING_DOT[state]}`} aria-hidden />
      {state}
    </span>
  );
}

const SEVERITY_DOT: Record<Severity, string> = {
  critical: "bg-risk",
  attention: "bg-warning",
  informational: "bg-muted-foreground/50",
};

export function SeverityBadge({ severity, label }: { severity: Severity; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium uppercase tracking-[0.04em] text-muted-foreground">
      <span className={`size-1.5 rounded-full ${SEVERITY_DOT[severity]}`} aria-hidden />
      {label}
    </span>
  );
}

export function SourceTag({ source, automated }: { source: string; automated: boolean }) {
  const label = source === "ais" ? "AIS" : source === "system" ? "System" : "Manual";
  const dot = automated ? "bg-primary" : "bg-muted-foreground/40";
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
      <span aria-hidden className={`size-1.5 rounded-full ${dot}`} />
      {label} · {automated ? "Automatic" : "Manual entry"}
    </span>
  );
}

export function DocsIndicator({ attached, total }: { attached: number; total: number }) {
  const complete = attached >= total;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm">
      <span
        aria-hidden
        className={`size-1.5 rounded-full ${complete ? "bg-positive" : attached === 0 ? "bg-risk" : "bg-warning"}`}
      />
      <span className={complete ? "text-foreground" : "text-muted-foreground"}>
        {attached}/{total}
      </span>
    </span>
  );
}

const CONDITION_DOT: Record<VesselCondition["kind"], string> = {
  underway: "bg-primary",
  stopped: "bg-warning",
  unknown: "bg-muted-foreground/50",
};

/** Derived AIS operational read (Underway / Stopped · likely …) — never a
 * lifecycle status. Callers should only render this when `label` (from
 * `vesselConditionLabel()`) is non-null. */
export function VesselConditionBadge({ condition, label }: { condition: VesselCondition; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm text-foreground">
      <span
        className={`size-1.5 rounded-full ${CONDITION_DOT[condition.kind]} ${condition.kind === "underway" ? "live-pulse" : ""}`}
        aria-hidden
      />
      {label}
    </span>
  );
}
