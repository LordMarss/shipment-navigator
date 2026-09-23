import { Link } from "@tanstack/react-router";
import { useMemo, type ReactNode } from "react";

import { formatEta, type Shipment } from "@/lib/api";
import { clock, monthName, tCount, weekday } from "@/components/maritime/format";
import { ChartPanel, Skeleton } from "@/components/maritime/marks";

const DAY = 86_400_000;
const WINDOW_DAYS = 14;
const MAX_ENTRIES = 12;
const FINISHED = new Set(["Arrived", "At Port", "Cleared Customs", "Delivered"]);

type Kind = "ETD" | "ETA";
type Movement = { shipment: Shipment; kind: Kind; at: number };

function startOfDay(t: number) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * The next two weeks of movements, set like a tide table: one ruled row
 * per day with its date in the margin, each movement on its own line with
 * a 24-hour time. Days without movements are left out, except today,
 * which carries the present-time mark. Anything already past its date and
 * unrecorded sits at the top as Overdue.
 */
export function Almanac({
  shipments,
  now,
  isLoading,
  focusId,
  onFocus,
}: {
  shipments: Shipment[];
  now: number | null;
  isLoading: boolean;
  focusId: string | null;
  onFocus: (id: string | null) => void;
}) {
  const model = useMemo(() => {
    if (now == null) return null;
    const today = startOfDay(now);
    const end = today + WINDOW_DAYS * DAY;
    const all: Movement[] = [];
    for (const s of shipments) {
      if (FINISHED.has(s.status)) continue;
      if (!s.actual_departure && s.planned_etd) {
        all.push({ shipment: s, kind: "ETD", at: new Date(s.planned_etd).getTime() });
      }
      if (!s.actual_arrival && s.eta)
        all.push({ shipment: s, kind: "ETA", at: new Date(s.eta).getTime() });
    }
    const overdue = all.filter((m) => m.at < now).sort((a, b) => a.at - b.at);
    const upcoming = all.filter((m) => m.at >= now && m.at < end).sort((a, b) => a.at - b.at);
    const later = all.filter((m) => m.at >= end).length;

    const shown = upcoming.slice(0, MAX_ENTRIES);
    const days = new Map<number, Movement[]>([[today, []]]);
    for (const m of shown) {
      const d = startOfDay(m.at);
      days.set(d, [...(days.get(d) ?? []), m]);
    }
    const counts = new Map<number, number>();
    for (const m of upcoming) counts.set(startOfDay(m.at), (counts.get(startOfDay(m.at)) ?? 0) + 1);

    return {
      today,
      overdue,
      days: [...days.entries()].sort((a, b) => a[0] - b[0]),
      counts,
      hidden: upcoming.length - shown.length + later,
    };
  }, [shipments, now]);

  return (
    <ChartPanel id="almanac" title="Movements" meta={`next ${WINDOW_DAYS} days`}>
      {isLoading || model == null ? (
        <div className="space-y-3 py-3">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-3/5" />
        </div>
      ) : (
        <>
          {model.overdue.length > 0 ? (
            <DayRow
              label={<span className="chart-label text-sea-red">Overdue</span>}
              movements={model.overdue.slice(0, 4)}
              now={now!}
              overdue
              focusId={focusId}
              onFocus={onFocus}
              extra={model.overdue.length > 4 ? `${model.overdue.length - 4} more overdue` : null}
            />
          ) : null}
          {model.days.map(([day, list]) => {
            const isToday = day === model.today;
            const count = model.counts.get(day) ?? 0;
            return (
              <DayRow
                key={day}
                label={
                  <>
                    <span
                      className={`chart-label block ${isToday ? "text-sea-ink" : "text-sea-ink-3"}`}
                    >
                      {isToday ? "Today" : weekday(day)}
                    </span>
                    <span className="block text-[17px] leading-tight tabular-nums text-sea-ink">
                      {new Date(day).getDate()}
                      <span className="chart-label ml-1 !text-[9.5px] text-sea-ink-3">
                        {monthName(day)}
                      </span>
                    </span>
                    {count > 1 ? (
                      <span aria-label={`${count} movements`} className="mt-1 flex gap-[2px]">
                        {Array.from({ length: Math.min(count, 6) }).map((_, i) => (
                          <span key={i} aria-hidden className="size-[4px] bg-sea-ink-3" />
                        ))}
                      </span>
                    ) : null}
                  </>
                }
                nowMark={isToday ? now! : null}
                movements={list}
                now={now!}
                focusId={focusId}
                onFocus={onFocus}
              />
            );
          })}
          {model.hidden > 0 ? (
            <p className="py-2.5 text-[12px] text-sea-ink-3">
              {model.hidden} more beyond this list
            </p>
          ) : null}
        </>
      )}
    </ChartPanel>
  );
}

function DayRow({
  label,
  movements,
  now,
  nowMark = null,
  overdue = false,
  focusId,
  onFocus,
  extra = null,
}: {
  label: ReactNode;
  movements: Movement[];
  now: number;
  nowMark?: number | null;
  overdue?: boolean;
  focusId: string | null;
  onFocus: (id: string | null) => void;
  extra?: string | null;
}) {
  return (
    <div className="grid grid-cols-[56px_minmax(0,1fr)] gap-x-3 border-b border-sea-rule-2 py-2.5">
      <div className="pt-0.5">{label}</div>
      <ul className="min-w-0">
        {nowMark != null ? (
          <li className="flex items-center gap-2 pb-1.5 pt-1" aria-label={`Now, ${clock(nowMark)}`}>
            <span className="telemetry text-[10.5px] text-sea-cursor">{clock(nowMark)}</span>
            <span aria-hidden className="h-px flex-1 bg-sea-cursor" />
            <span className="chart-label !text-[9.5px] text-sea-cursor">Now</span>
          </li>
        ) : null}
        {movements.length === 0 && nowMark != null ? (
          <li className="py-1 text-[12.5px] text-sea-ink-3">No movements today</li>
        ) : null}
        {movements.map((m) => {
          const cursor = focusId === m.shipment.id;
          const port = m.kind === "ETA" ? m.shipment.destination : m.shipment.origin;
          return (
            <li key={`${m.shipment.id}-${m.kind}`}>
              <Link
                to="/shipments/$id"
                params={{ id: m.shipment.id }}
                onMouseEnter={() => onFocus(m.shipment.id)}
                onMouseLeave={() => onFocus(null)}
                onFocus={() => onFocus(m.shipment.id)}
                onBlur={() => onFocus(null)}
                title={`${m.kind === "ETA" ? "Arrives" : "Departs"} ${port}, ${formatEta(new Date(m.at).toISOString())}`}
                className={`focus-ring grid grid-cols-[40px_30px_minmax(0,1fr)] items-baseline gap-x-2 rounded-[1px] py-1 text-[12.5px] ${
                  cursor ? "bg-sea-shallows" : "hover:bg-sea-shallows/60"
                }`}
              >
                <span
                  className={`telemetry text-[11px] ${overdue ? "text-sea-red" : "text-sea-ink-2"}`}
                >
                  {overdue ? tCount(new Date(m.at).toISOString(), now).label : clock(m.at)}
                </span>
                <span className="flex items-center gap-1">
                  <span
                    aria-hidden
                    className={`size-[6px] rounded-full border-[1.5px] ${
                      cursor
                        ? "border-sea-cursor bg-sea-cursor"
                        : m.kind === "ETA"
                          ? "border-sea-ink bg-sea-ink"
                          : "border-sea-ink-2 bg-transparent"
                    }`}
                  />
                  <span className="chart-label !text-[9.5px] text-sea-ink-3">{m.kind}</span>
                </span>
                <span className="min-w-0 truncate">
                  <span className={cursor ? "text-sea-cursor" : "text-sea-ink"}>
                    {m.shipment.client_name}
                  </span>
                  <span className="text-sea-ink-3"> {port}</span>
                </span>
              </Link>
            </li>
          );
        })}
        {extra ? <li className="py-1 text-[12px] text-sea-ink-3">{extra}</li> : null}
      </ul>
    </div>
  );
}
