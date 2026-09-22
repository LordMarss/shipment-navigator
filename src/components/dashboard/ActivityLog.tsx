import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { Skeleton } from "@/components/AppShell";
import type { Alert, Shipment, ShipmentEvent } from "@/lib/api";
import { alertSeverity, SEVERITY_LABEL, type Severity } from "@/lib/lifecycle";
import { ago } from "@/components/dashboard/format";

type Entry = {
  key: string;
  at: string;
  shipmentId: string | null;
  /** Alert messages already name their shipment, so they skip the prefix. */
  prefixClient: boolean;
  text: string;
  source: string;
  mark: string;
  sourceTone: string;
};

const ALERT_MARK: Record<Severity, string> = {
  critical: "bg-risk",
  attention: "bg-warning",
  informational: "border border-foreground/40",
};

const ALERT_TONE: Record<Severity, string> = {
  critical: "font-medium text-risk",
  attention: "font-medium text-warning",
  informational: "text-muted-foreground",
};

function sourceLabel(source: string) {
  return source === "ais" ? "AIS" : source === "system" ? "System" : "Manual";
}

const MAX_ENTRIES = 8;

/**
 * The watch log: lifecycle events and alerts interleaved by time on one
 * ruled sheet, two columns wide on large screens. The mark before the
 * source says what kind of entry it is: filled blue for an automatic
 * reading, open for a manual entry, red / amber / open for an alert.
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
      source: event.automated
        ? `${sourceLabel(event.source)}, automatic`
        : sourceLabel(event.source),
      mark: event.automated ? "bg-primary" : "border border-primary",
      sourceTone: "text-muted-foreground",
    })),
    ...alerts.map((alert) => {
      const severity = alertSeverity(alert);
      return {
        key: `a-${alert.id}`,
        at: alert.created_at,
        shipmentId: alert.shipment_id,
        prefixClient: false,
        text: alert.message,
        source: severity === "informational" ? "Alert" : `${SEVERITY_LABEL[severity]} alert`,
        mark: ALERT_MARK[severity],
        sourceTone: ALERT_TONE[severity],
      };
    }),
  ]
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, MAX_ENTRIES);

  if (isLoading) {
    return (
      <div className="grid gap-x-12 lg:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-2 border-b border-foreground/8 py-4">
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-3 w-24" />
          </div>
        ))}
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Nothing logged yet. Status changes, ETA revisions and alerts are recorded here as they
        happen.
      </p>
    );
  }

  return (
    <ol className="grid gap-x-12 border-t border-foreground/20 lg:grid-cols-2">
      {entries.map((entry, i) => {
        const shipment = entry.shipmentId ? shipmentById.get(entry.shipmentId) : undefined;
        const body: ReactNode = (
          <span className="grid grid-cols-[44px_minmax(0,1fr)] gap-x-3">
            <time
              dateTime={entry.at}
              title={new Date(entry.at).toLocaleString()}
              className="instrument pt-[3px] text-[11px] text-muted-foreground"
            >
              {now != null ? ago(entry.at, now) : ""}
            </time>
            <span className="min-w-0">
              <span className="line-clamp-2 text-[13.5px] leading-[1.45] text-foreground">
                {shipment && entry.prefixClient ? (
                  <span className="font-medium">{shipment.client_name} </span>
                ) : null}
                <span className="text-foreground/75">{entry.text}</span>
              </span>
              <span className={`mt-1 flex items-center gap-1.5 text-xs ${entry.sourceTone}`}>
                <span aria-hidden className={`size-[6px] shrink-0 rounded-full ${entry.mark}`} />
                {entry.source}
              </span>
            </span>
          </span>
        );
        return (
          <li
            key={entry.key}
            className={`border-b border-foreground/8 ${i >= 5 ? "max-md:hidden" : ""}`}
          >
            {shipment ? (
              <Link
                to="/shipments/$id"
                params={{ id: shipment.id }}
                className="focus-ring -mx-2 block rounded-[2px] px-2 py-3.5 transition-colors duration-150 hover:bg-atmosphere/45"
              >
                {body}
              </Link>
            ) : (
              <div className="py-3.5">{body}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
