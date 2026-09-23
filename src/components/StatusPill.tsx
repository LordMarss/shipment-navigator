import type { VesselCondition } from "@/lib/aisAutomation";
import type { ShipmentStatus } from "@/lib/api";
import type { HealthLevel, MonitoringState, Severity } from "@/lib/lifecycle";
import { conditionOf } from "@/components/maritime/format";
import {
  AisTarget,
  ConditionMark,
  ManifestMeter,
  PhaseLadder,
  SourceMark,
} from "@/components/maritime/marks";

/*
 * Status vocabulary, shared by every page. Drawn from the same maritime
 * marks as the dashboard so a state reads the same everywhere:
 *
 *   phase       a small square in the phase family's colour: slate before
 *               departure, chart blue under way, marine green arrived,
 *               amber held at port. The label always stays ink.
 *   health      alarm (red diamond) / caution (amber triangle) / normal
 *   severity    the same alarm / caution marks for alerts
 *   source      filled square = automatic, hollow = operator
 *   vessel      the AIS target symbol
 */

export type StatusAccent = "neutral" | "primary" | "positive" | "warning";

/** Which accent family a status belongs to, shared so the lifecycle
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

const ACCENT_FILL: Record<StatusAccent, string> = {
  neutral: "bg-sea-ink-3",
  primary: "bg-sea-move",
  positive: "bg-sea-green",
  warning: "bg-sea-amber",
};

function PhaseSquare({ status, size = 6 }: { status: ShipmentStatus; size?: number }) {
  return (
    <span
      aria-hidden
      className={`inline-block shrink-0 ${ACCENT_FILL[statusAccent(status)]}`}
      style={{ width: size, height: size }}
    />
  );
}

/** Phase as the six-tick ladder beside its name, so a column of these reads
 * as a measurement rather than a row of badges. `lg` is the page-level
 * reading on a shipment record. */
export function StatusPill({
  status,
  size = "sm",
}: {
  status: ShipmentStatus;
  size?: "sm" | "lg";
}) {
  return (
    <span
      className={`inline-flex items-center gap-2 whitespace-nowrap text-foreground ${size === "lg" ? "text-[15px] font-medium" : "text-[13px]"}`}
    >
      <PhaseLadder status={status} size={size === "lg" ? "md" : "sm"} />
      {status}
    </span>
  );
}

export function HealthBadge({ level }: { level: HealthLevel }) {
  const condition = conditionOf(level);
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap text-sm text-foreground">
      {condition ? (
        <ConditionMark level={condition} size={8} />
      ) : (
        <span
          aria-hidden
          className={`inline-block size-[7px] shrink-0 rounded-full ${
            level === "Delivered" ? "bg-sea-green" : "border-[1.5px] border-sea-green"
          }`}
        />
      )}
      {level}
    </span>
  );
}

const MONITORING_MARK: Record<MonitoringState, string> = {
  Scheduled: "bg-sea-ink-3",
  "Pre-Monitoring": "border-[1.5px] border-sea-amber",
  "Active Monitoring": "bg-sea-move",
  Completed: "bg-sea-green",
};

export function MonitoringBadge({ state }: { state: MonitoringState }) {
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap text-sm text-foreground">
      <span aria-hidden className={`inline-block size-[6px] shrink-0 ${MONITORING_MARK[state]}`} />
      {state}
    </span>
  );
}

const SEVERITY_TEXT: Record<Severity, string> = {
  critical: "text-sea-red",
  attention: "text-sea-amber-ink",
  informational: "text-muted-foreground",
};

/** Severity in the bridge alert vocabulary: critical carries the alarm
 * mark, attention the caution mark; informational recedes. */
export function SeverityBadge({ severity, label }: { severity: Severity; label: string }) {
  return (
    <span
      className={`label-xs inline-flex items-center gap-1.5 whitespace-nowrap !text-[10.5px] ${SEVERITY_TEXT[severity]}`}
    >
      {severity === "critical" ? (
        <ConditionMark level="alarm" size={7} />
      ) : severity === "attention" ? (
        <ConditionMark level="caution" size={7} />
      ) : (
        <span
          aria-hidden
          className="inline-block size-[6px] shrink-0 border-[1.5px] border-sea-ink-4"
        />
      )}
      {label}
    </span>
  );
}

export function SourceTag({ source, automated }: { source: string; automated: boolean }) {
  const code = source === "ais" ? "AIS" : source === "system" ? "SYS" : automated ? "SYS" : "OPR";
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
      <SourceMark source={source} automated={automated} />
      <span className="telemetry text-[10.5px]">{code}</span>
      <span>{automated ? "automatic" : "operator entry"}</span>
    </span>
  );
}

export function DocsIndicator({ attached, total }: { attached: number; total: number }) {
  return <ManifestMeter attached={attached} total={total} />;
}

/** Derived AIS operational read (Underway / Stopped · likely …), never a
 * lifecycle status, drawn with the AIS target symbol. Callers should only
 * render this when `label` (from `vesselConditionLabel()`) is non-null. */
export function VesselConditionBadge({
  condition,
  label,
}: {
  condition: VesselCondition;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap text-sm text-foreground">
      <AisTarget
        state={condition.kind === "underway" ? "active" : "idle"}
        stopped={condition.kind === "stopped"}
        size={11}
      />
      {label}
    </span>
  );
}
