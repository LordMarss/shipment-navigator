import { Link } from "@tanstack/react-router";
import { Fragment, type ReactNode } from "react";

import type { Alert, Shipment, ShipmentEvent } from "@/lib/api";
import { alertSeverity, type Severity } from "@/lib/lifecycle";
import { clock, humanField, logValue, monthName, weekday } from "@/components/maritime/format";
import { ChartPanel, ConditionMark, Skeleton } from "@/components/maritime/marks";

type Entry = {
  key: string;
  at: string;
  shipmentId: string | null;
  /** Alert messages already name their shipment, so they skip the prefix. */
  prefixClient: boolean;
  text: string;
  code: string;
  automatic: boolean;
  severity: Severity | null;
};

function sourceCode(source: string, automated: boolean) {
  if (source === "ais") return "AIS";
  if (source === "system") return "SYS";
  return automated ? "SYS" : "OPR";
}

const MAX_ENTRIES = 8;

/**
 * The deck log: events and alerts interleaved by time, each stamped with a
 * 24-hour time (or date, beyond a day) and a source code. Automatic entries
 * (AIS, SYS) carry a filled square and operator entries (OPR) a hollow one,
 * so they read apart by shape. Alerts carry their condition mark.
 */
export function DeckLog({
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
          ? `${humanField(event.field, event.event_type) || "Phase"} → ${event.to_value ? logValue(event.to_value, now) : "cleared"}`
          : (event.reason ?? event.event_type),
      code: sourceCode(event.source, event.automated),
      automatic: event.automated,
      severity: null,
    })),
    ...alerts.map((alert) => ({
      key: `a-${alert.id}`,
      at: alert.created_at,
      shipmentId: alert.shipment_id,
      prefixClient: false,
      text: alert.message,
      code: "ALRT",
      automatic: true,
      severity: alertSeverity(alert),
    })),
  ]
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, MAX_ENTRIES);

  return (
    <ChartPanel quiet id="log" title="Recent changes" meta="deck log">
      {isLoading ? (
        <div className="space-y-3 py-3">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-4/5" />
        </div>
      ) : entries.length === 0 ? (
        <p className="border-b border-sea-rule-2 py-4 text-[13px] text-sea-ink-3">
          Nothing logged yet. Status changes, ETA revisions and alerts are entered here as they
          happen.
        </p>
      ) : (
        <ol>
          {entries.map((entry, i) => {
            const shipment = entry.shipmentId ? shipmentById.get(entry.shipmentId) : undefined;
            const mark =
              entry.severity === "critical" ? (
                <ConditionMark level="alarm" size={7} />
              ) : entry.severity === "attention" ? (
                <ConditionMark level="caution" size={7} />
              ) : (
                <span
                  aria-hidden
                  className={`inline-block size-[6px] ${
                    entry.automatic ? "bg-sea-ink-2" : "border-[1.5px] border-sea-ink-2"
                  }`}
                />
              );
            const body: ReactNode = (
              <span className="grid grid-cols-[44px_46px_minmax(0,1fr)] items-baseline gap-x-2">
                <time
                  dateTime={entry.at}
                  title={new Date(entry.at).toLocaleString()}
                  className="telemetry text-[11px] text-sea-ink-2"
                >
                  {clock(new Date(entry.at).getTime())}
                </time>
                <span className="flex items-center gap-1.5">
                  {mark}
                  <span className="telemetry text-[10px] text-sea-ink-3">{entry.code}</span>
                  <span className="sr-only">{entry.automatic ? ", automatic" : ", operator"}</span>
                </span>
                <span className="line-clamp-2 text-[12.5px] leading-[1.45]">
                  {shipment && entry.prefixClient ? (
                    <span className="font-medium text-sea-ink">{shipment.client_name} </span>
                  ) : null}
                  <span className="text-sea-ink-2">{entry.text}</span>
                </span>
              </span>
            );
            // Rule off each day, as a logbook does; times within it are 24-hour.
            const day = new Date(entry.at).toDateString();
            const prev = i > 0 ? new Date(entries[i - 1]!.at).toDateString() : null;
            const isToday = now != null && day === new Date(now).toDateString();
            const t = new Date(entry.at).getTime();
            const dayHead =
              day !== prev && (prev != null || !isToday) ? (
                <li
                  className={`chart-label border-b border-sea-rule pb-1 pt-3 !text-[10px] text-sea-ink-3 ${i >= 5 ? "max-md:hidden" : ""}`}
                >
                  {isToday ? "Today" : `${weekday(t)} ${new Date(t).getDate()} ${monthName(t)}`}
                </li>
              ) : null;
            return (
              <Fragment key={entry.key}>
                {dayHead}
                <li className={`border-b border-sea-rule-2 ${i >= 5 ? "max-md:hidden" : ""}`}>
                  {shipment ? (
                    <Link
                      to="/shipments/$id"
                      params={{ id: shipment.id }}
                      className="focus-ring block rounded-[1px] py-2 transition-colors duration-100 hover:bg-sea-shallows/60"
                    >
                      {body}
                    </Link>
                  ) : (
                    <div className="py-2">{body}</div>
                  )}
                </li>
              </Fragment>
            );
          })}
        </ol>
      )}
    </ChartPanel>
  );
}
