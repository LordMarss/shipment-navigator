import { Anchor, BookmarkCheck, CalendarClock, CheckCircle2, MapPin, Ship, type LucideIcon } from "lucide-react";

import type { VesselCondition } from "@/lib/aisAutomation";
import type { ShipmentStatus } from "@/lib/api";
import type { HealthLevel, MonitoringState, Severity } from "@/lib/lifecycle";

/**
 * Each stage of the lifecycle gets its own meaning, not one flat accent:
 * Scheduled/Booked (not yet moving) — neutral slate.
 * Departed / Approaching Destination (transition points) — teal, the
 * same accent used for live AIS data, since these are AIS-observed moments.
 * In Transit (the long middle stretch, underway) — the primary operational blue.
 * Arrived (success) — green. At Port (needs follow-up) — amber.
 */
const TONE: Record<ShipmentStatus, string> = {
  Scheduled: "bg-subtle text-muted-foreground border-border",
  Booked: "bg-subtle text-muted-foreground border-border",
  Departed: "bg-teal-soft text-teal border-teal/25",
  "In Transit": "bg-primary/[0.08] text-primary border-primary/25",
  "Approaching Destination": "bg-teal-soft text-teal border-teal/25",
  Arrived: "bg-positive-soft text-positive border-positive/25",
  "At Port": "bg-warning-soft text-warning border-warning/25",
  "Cleared Customs": "bg-positive-soft text-positive border-positive/25",
  Delivered: "bg-positive-soft text-positive border-positive/25",
};

const DOT: Record<ShipmentStatus, string> = {
  Scheduled: "bg-muted-foreground/50",
  Booked: "bg-muted-foreground/50",
  Departed: "bg-teal",
  "In Transit": "bg-primary",
  "Approaching Destination": "bg-teal",
  Arrived: "bg-positive",
  "At Port": "bg-warning",
  "Cleared Customs": "bg-positive",
  Delivered: "bg-positive",
};

export type StatusAccent = "neutral" | "teal" | "primary" | "positive" | "warning";

/** Which accent family a status belongs to — shared so the lifecycle
 * stepper and change history on the shipment detail page use exactly the
 * same colour-to-status mapping as StatusPill itself. */
export function statusAccent(status: ShipmentStatus): StatusAccent {
  switch (status) {
    case "Departed":
    case "Approaching Destination":
      return "teal";
    case "In Transit":
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

/** `size="lg"` renders a bigger, rounded-full pill with a status icon
 * (used for a page's primary status display); `sm` (default) is the
 * original compact dot pill used everywhere else. Same color tokens. */
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
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium whitespace-nowrap ${TONE[status] ?? TONE.Booked}`}
      >
        {Icon ? (
          <Icon className="size-3.5" aria-hidden />
        ) : (
          <span className={`size-1.5 rounded-full ${DOT[status] ?? DOT.Booked}`} aria-hidden />
        )}
        {status}
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap ${TONE[status] ?? TONE.Booked}`}
    >
      <span className={`size-1.5 rounded-full ${DOT[status] ?? DOT.Booked}`} aria-hidden />
      {status}
    </span>
  );
}

const HEALTH: Record<HealthLevel, string> = {
  "On Track": "bg-positive-soft text-positive border-positive/25",
  Attention: "bg-warning-soft text-warning border-warning/25",
  "At Risk": "bg-risk-soft text-risk border-risk/25",
  Delayed: "bg-risk-soft text-risk border-risk/25",
  Delivered: "bg-subtle text-muted-foreground border-border",
};

const HEALTH_DOT: Record<HealthLevel, string> = {
  "On Track": "bg-positive",
  Attention: "bg-warning",
  "At Risk": "bg-risk",
  Delayed: "bg-risk",
  Delivered: "bg-muted-foreground/50",
};

export function HealthBadge({ level }: { level: HealthLevel }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap ${HEALTH[level]}`}
    >
      <span className={`size-1.5 rounded-full ${HEALTH_DOT[level]}`} aria-hidden />
      {level}
    </span>
  );
}

const MONITORING: Record<MonitoringState, string> = {
  Scheduled: "bg-subtle text-muted-foreground border-border",
  "Pre-Monitoring": "bg-warning-soft text-warning border-warning/25",
  "Active Monitoring": "bg-primary/[0.07] text-primary border-primary/20",
  Completed: "bg-positive-soft text-positive border-positive/25",
};

export function MonitoringBadge({ state }: { state: MonitoringState }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap ${MONITORING[state]}`}
    >
      {state}
    </span>
  );
}

const SEVERITY: Record<Severity, string> = {
  critical: "bg-risk-soft text-risk border-risk/25",
  attention: "bg-warning-soft text-warning border-warning/25",
  informational: "bg-subtle text-muted-foreground border-border",
};

export function SeverityBadge({ severity, label }: { severity: Severity; label: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.05em] whitespace-nowrap ${SEVERITY[severity]}`}
    >
      {label}
    </span>
  );
}

export function SourceTag({ source, automated }: { source: string; automated: boolean }) {
  const label = source === "ais" ? "AIS" : source === "system" ? "System" : "Manual";
  const dot = !automated ? "bg-muted-foreground/40" : source === "ais" ? "bg-teal" : "bg-primary/70";
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-muted-foreground">
      <span aria-hidden className={`size-1.5 rounded-full ${dot}`} />
      {label} · {automated ? "Automatic" : "Manual entry"}
    </span>
  );
}

export function DocsIndicator({ attached, total }: { attached: number; total: number }) {
  const complete = attached >= total;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12px]">
      <span
        aria-hidden
        className={`size-1.5 rounded-full ${complete ? "bg-positive" : attached === 0 ? "bg-risk" : "bg-warning"}`}
      />
      <span className={complete ? "text-positive" : "text-muted-foreground"}>
        {attached}/{total}
      </span>
    </span>
  );
}

const CONDITION_TONE: Record<VesselCondition["kind"], string> = {
  underway: "bg-teal-soft text-teal border-teal/25",
  stopped: "bg-warning-soft text-warning border-warning/25",
  unknown: "bg-subtle text-muted-foreground border-border",
};

const CONDITION_DOT: Record<VesselCondition["kind"], string> = {
  underway: "bg-teal",
  stopped: "bg-warning",
  unknown: "bg-muted-foreground/50",
};

/** Derived AIS operational read (Underway / Stopped · likely …) — never a
 * lifecycle status. Sized and styled like HealthBadge/MonitoringBadge so it
 * never visually competes with the actual StatusPill. Callers should only
 * render this when `label` (from `vesselConditionLabel()`) is non-null. */
export function VesselConditionBadge({ condition, label }: { condition: VesselCondition; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap ${CONDITION_TONE[condition.kind]}`}
    >
      <span
        className={`size-1.5 rounded-full ${CONDITION_DOT[condition.kind]} ${condition.kind === "underway" ? "live-pulse" : ""}`}
        aria-hidden
      />
      {label}
    </span>
  );
}
