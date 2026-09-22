import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import type { Alert, Shipment, ShipmentEvent } from "@/lib/api";
import { alertSeverity, SEVERITY_LABEL, type Severity } from "@/lib/lifecycle";
import { ago } from "@/components/dashboard/format";
import { Mark, Skeleton } from "@/components/dashboard/glyphs";

type Entry = {
  key: string;
  at: string;
  shipmentId: string | null;
  /** Alert messages already name their shipment, so they skip the prefix. */
  prefixClient: boolean;
  text: string;
  /** Source code shown in the log's SRC column. */
  code: string;
  /** Automatic readings are filled marks; operator actions are hollow. */
  automatic: boolean;
  tone: "ink" | "quiet" | "alert" | "caution";
  detail: string | null;
};

const ALERT_TONE: Record<Severity, Entry["tone"]> = {
  critical: "alert",
  attention: "caution",
  informational: "quiet",
};

function sourceCode(source: string, automated: boolean) {
  if (source === "ais") return "AIS";
  if (source === "system") return "SYS";
  return automated ? "SYS" : "OPR";
}

const MAX_ENTRIES = 8;
const COLS = "grid-cols-[40px_50px_minmax(0,1fr)]";

/**
 * The watch log: lifecycle events and alerts interleaved by time on one
 * ruled sheet, in three fixed columns (time, source, entry). Automatic
 * entries (AIS, system) carry a filled mark and operator entries a hollow
 * one, so the two read apart by shape before colour. Alerts keep their
 * severity as a word; only critical and attention alerts take a colour.
 */
export function ActivityLog({
  events,
  alerts,
  shipmentById,
  isLoading,
  now,
}: {
  events: ShipmentEvent[];
  alerts: Alert[];
  shipmentById: Map<string, Shipment>;
  isLoading: boolean;
  now: number | null;
}) {
  const entries: Entry[] = [
    ...events.map((event) => ({
      key: `e-${event.id}`,
      at: event.occurred_at,
      shipmentId: event.shipment_id,
      prefixClient: true,
      text:
        event.field && (event.from_value || event.to_value)
          ? `${event.field} → ${event.to_value ?? "cleared"}`
          : (event.reason ?? event.event_type),
      code: sourceCode(event.source, event.automated),
      automatic: event.automated,
      tone: "ink" as const,
      detail: null,
    })),
    ...alerts.map((alert) => {
      const severity = alertSeverity(alert);
      return {
        key: `a-${alert.id}`,
        at: alert.created_at,
        shipmentId: alert.shipment_id,
        prefixClient: false,
        text: alert.message,
        code: "ALRT",
        automatic: true,
        tone: ALERT_TONE[severity],
        detail: severity === "informational" ? null : SEVERITY_LABEL[severity],
      };
    }),
  ]
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, MAX_ENTRIES);

  if (isLoading) {
    return (
      <div className="grid gap-x-12 border-t border-rule-1 lg:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="border-b border-rule-2 py-3.5">
            <Skeleton className="h-4 w-4/5" />
          </div>
        ))}
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <p className="border-y border-rule-2 py-4 text-[13px] text-ink-3">
        Nothing logged yet. Status changes, ETA revisions and alerts are recorded here as they
        happen.
      </p>
    );
  }

  return (
    <div className="grid gap-x-12 lg:grid-cols-2">
      {/* Column heads repeat per column on wide screens */}
      {[0, 1].map((col) => (
        <div
          key={col}
          aria-hidden
          className={`${col === 1 ? "hidden lg:grid" : "grid"} ${COLS} gap-x-3 border-b border-rule-1 pb-2 text-[11.5px] text-ink-3`}
        >
          <span>Time</span>
          <span>Source</span>
          <span>Entry</span>
        </div>
      ))}
      <ol className="contents">
        {entries.map((entry, i) => {
          const shipment = entry.shipmentId ? shipmentById.get(entry.shipmentId) : undefined;
          const body: ReactNode = (
            <span className={`grid ${COLS} items-baseline gap-x-3`}>
              <time
                dateTime={entry.at}
                title={new Date(entry.at).toLocaleString()}
                className="telemetry text-[11px] text-ink-3"
              >
                {now != null ? ago(entry.at, now) : ""}
              </time>
              <span className="flex items-center gap-1.5">
                <Mark filled={entry.automatic} tone={entry.tone} size={6} />
                <span className="telemetry text-[10.5px] text-ink-2">{entry.code}</span>
                <span className="sr-only">{entry.automatic ? ", automatic" : ", operator"}</span>
              </span>
              <span className="min-w-0">
                <span className="line-clamp-2 text-[13px] leading-[1.45]">
                  {shipment && entry.prefixClient ? (
                    <span className="font-medium text-ink-1">{shipment.client_name} </span>
                  ) : null}
                  <span className="text-ink-2">{entry.text}</span>
                </span>
                {entry.detail ? (
                  <span
                    className={`mt-0.5 block text-[11.5px] font-medium ${
                      entry.tone === "alert" ? "text-alert" : "text-caution-ink"
                    }`}
                  >
                    {entry.detail}
                  </span>
                ) : null}
              </span>
            </span>
          );
          return (
            <li
              key={entry.key}
              className={`border-b border-rule-2 ${i >= 5 ? "max-md:hidden" : ""}`}
            >
              {shipment ? (
                <Link
                  to="/shipments/$id"
                  params={{ id: shipment.id }}
                  className="focus-ring block rounded-[1px] py-2.5 transition-colors duration-100 hover:bg-wash"
                >
                  {body}
                </Link>
              ) : (
                <div className="py-2.5">{body}</div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
