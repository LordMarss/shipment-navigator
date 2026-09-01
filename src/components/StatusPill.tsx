import type { ShipmentStatus } from "@/lib/api";
import type { HealthLevel, Severity } from "@/lib/insights";

const TONE: Record<ShipmentStatus, string> = {
  Booked: "bg-subtle text-muted-foreground border-border",
  "In Transit": "bg-primary/[0.07] text-primary border-primary/20",
  "At Port": "bg-warning-soft text-warning border-warning/25",
  "Cleared Customs": "bg-positive-soft text-positive border-positive/25",
  Delivered: "bg-positive-soft text-positive border-positive/25",
};

const DOT: Record<ShipmentStatus, string> = {
  Booked: "bg-muted-foreground/50",
  "In Transit": "bg-primary",
  "At Port": "bg-warning",
  "Cleared Customs": "bg-positive",
  Delivered: "bg-positive",
};

export function StatusPill({ status }: { status: ShipmentStatus }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap ${TONE[status]}`}
    >
      <span className={`size-1.5 rounded-full ${DOT[status]}`} aria-hidden />
      {status}
    </span>
  );
}

const HEALTH: Record<HealthLevel, string> = {
  "On Track": "bg-positive-soft text-positive border-positive/25",
  "Attention Required": "bg-warning-soft text-warning border-warning/25",
  "At Risk": "bg-risk-soft text-risk border-risk/25",
  Delivered: "bg-subtle text-muted-foreground border-border",
};

const HEALTH_DOT: Record<HealthLevel, string> = {
  "On Track": "bg-positive",
  "Attention Required": "bg-warning",
  "At Risk": "bg-risk",
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
