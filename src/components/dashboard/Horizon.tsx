import { Link } from "@tanstack/react-router";
import { useMemo } from "react";

import { formatEta, shortId, type Shipment } from "@/lib/api";
import { useElementWidth } from "@/components/dashboard/useNow";
import { tCount } from "@/components/dashboard/format";
import { Mark, Skeleton } from "@/components/dashboard/glyphs";

const DAY = 86_400_000;
/** Label width used for lane packing; matches the flag's `max-w`. */
const LABEL_PX = 156;
const LANE_PX = 28;
const MAX_LANES = 4;
const MAX_LANES_NARROW = 3;
const BODY_PAD = 12;
const OVERDUE_PX = 168;
const TIP_PX = 248;
/** Load strip: one square per movement, up to this many, then a count. */
const LOAD_CELLS = 5;

const FINISHED = new Set(["Arrived", "At Port", "Cleared Customs", "Delivered"]);

type Kind = "departure" | "arrival";
type ScheduleEvent = { shipment: Shipment; kind: Kind; at: number };
type Placed = ScheduleEvent & { x: number; lane: number; flip: boolean; tipFlip: boolean };

function startOfDay(t: number) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * The schedule as a planning instrument: a day scale, one ruled column per
 * day, and every planned departure (hollow square) and arrival (solid
 * square) hung from its exact time. Beneath the plot a load strip counts
 * the movements per day, so congestion reads at a glance. The present
 * moment is the one blue line. Movements whose date has passed without
 * being recorded collect in an Overdue column to the left. Fourteen days
 * on wide screens, seven on narrow ones.
 */
export function Horizon({
  shipments,
  now,
  focusId,
  onFocus,
  isLoading,
}: {
  isLoading: boolean;
  shipments: Shipment[];
  now: number | null;
  focusId: string | null;
  onFocus: (id: string | null) => void;
}) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const narrow = width > 0 && width < 600;
  const days = narrow ? 7 : 14;

  const model = useMemo(() => {
    if (now == null) return null;
    const start = startOfDay(now);
    const end = start + days * DAY;

    const events: ScheduleEvent[] = [];
    for (const s of shipments) {
      if (FINISHED.has(s.status)) continue;
      if (!s.actual_departure && s.planned_etd) {
        events.push({ shipment: s, kind: "departure", at: new Date(s.planned_etd).getTime() });
      }
      if (!s.actual_arrival && s.eta) {
        events.push({ shipment: s, kind: "arrival", at: new Date(s.eta).getTime() });
      }
    }

    const overdue = events.filter((e) => e.at < now).sort((a, b) => a.at - b.at);
    const later = events.filter((e) => e.at >= end).length;
    const inWindow = events.filter((e) => e.at >= now && e.at < end).sort((a, b) => a.at - b.at);

    const load = Array.from({ length: days }, () => 0);
    for (const e of inWindow) load[Math.floor((e.at - start) / DAY)]! += 1;

    // The overdue column sits beside the plot on wide screens, above it on narrow ones.
    const plotWidth = Math.max(1, width - (overdue.length > 0 && !narrow ? OVERDUE_PX : 0));
    // Greedy lane packing on estimated label extents. When every lane is
    // taken, the event folds into its day's "+N" marker instead of being
    // drawn over a neighbour.
    const maxLanes = narrow ? MAX_LANES_NARROW : MAX_LANES;
    const laneEnds: number[] = [];
    const placed: Placed[] = [];
    const folded = new Map<number, ScheduleEvent[]>();
    for (const e of inWindow) {
      const x = (e.at - start) / (end - start);
      const px = x * plotWidth;
      const flip = px + LABEL_PX > plotWidth;
      const from = flip ? px - LABEL_PX : px;
      let lane = laneEnds.findIndex((endPx) => endPx + 10 <= from);
      if (lane === -1 && laneEnds.length < maxLanes) {
        lane = laneEnds.length;
        laneEnds.push(0);
      }
      if (lane === -1) {
        const day = Math.floor((e.at - start) / DAY);
        folded.set(day, [...(folded.get(day) ?? []), e]);
        continue;
      }
      laneEnds[lane] = from + LABEL_PX;
      placed.push({ ...e, x, lane, flip, tipFlip: px + TIP_PX > plotWidth });
    }

    const columns = Array.from({ length: days }, (_, i) => {
      const d = new Date(start + i * DAY);
      return { t: d.getTime(), date: d, weekend: d.getDay() === 0 || d.getDay() === 6 };
    });

    return {
      overdue,
      later,
      placed,
      folded,
      load,
      plotWidth,
      columns,
      lanes: Math.max(2, laneEnds.length) + (folded.size > 0 ? 1 : 0),
      nowX: (now - start) / (end - start),
    };
  }, [shipments, now, width, days, narrow]);

  const bodyHeight = (model?.lanes ?? 2) * LANE_PX + BODY_PAD * 2;
  const focusActive =
    focusId != null && Boolean(model?.placed.some((e) => e.shipment.id === focusId));
  const cols = { gridTemplateColumns: `repeat(${days}, minmax(0, 1fr))` };

  return (
    <div ref={ref} className="min-w-0">
      {model == null || isLoading ? (
        <Skeleton className="h-36 w-full" />
      ) : (
        <div className="flex flex-col gap-5 sm:flex-row sm:gap-0">
          {model.overdue.length > 0 ? <OverdueColumn events={model.overdue} now={now!} /> : null}

          <div className="relative min-w-0 flex-1">
            {/* Day scale */}
            <div className="grid border-b border-rule-1" style={cols}>
              {model.columns.map((c, i) => {
                const today = i === 0;
                const monthTurn = c.date.getDate() === 1;
                return (
                  <div
                    key={c.t}
                    className={`min-w-0 pb-2 pl-1.5 ${i > 0 ? "border-l border-rule-3" : ""} ${today ? "bg-sunken" : ""}`}
                  >
                    <span
                      className={`block text-[11px] ${today ? "whitespace-nowrap font-medium text-ink-1" : "truncate"} ${
                        !today && monthTurn ? "font-medium text-ink-1" : !today ? "text-ink-3" : ""
                      }`}
                    >
                      {today
                        ? "Today"
                        : monthTurn
                          ? c.date.toLocaleDateString("en-GB", { month: "short" })
                          : c.date.toLocaleDateString("en-GB", { weekday: "short" })}
                    </span>
                    <span
                      className={`block text-[15px] leading-tight tabular-nums ${
                        today ? "font-semibold text-ink-1" : c.weekend ? "text-ink-3" : "text-ink-1"
                      }`}
                    >
                      {c.date.getDate()}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Plot */}
            <div className="relative" style={{ height: bodyHeight }}>
              <div aria-hidden className="absolute inset-0 grid" style={cols}>
                {model.columns.map((c, i) => (
                  <div
                    key={c.t}
                    className={`${i > 0 ? "border-l border-rule-3" : ""} ${i === 0 ? "bg-sunken" : ""}`}
                  />
                ))}
              </div>

              <span
                aria-hidden
                className="absolute -top-px bottom-0 w-px bg-signal"
                style={{ left: `${model.nowX * 100}%` }}
              >
                <span className="absolute -left-[2px] -top-[2px] size-[5px] bg-signal" />
              </span>

              {[...model.folded.entries()].map(([day, list]) => (
                <FoldedDay
                  key={day}
                  list={list}
                  day={day}
                  days={days}
                  top={BODY_PAD + (model.lanes - 1) * LANE_PX}
                  now={now!}
                  plotWidth={model.plotWidth}
                />
              ))}

              {model.placed.length === 0 ? (
                <p className="absolute left-4 right-2 top-1/2 -translate-y-1/2 bg-paper px-2 py-1 text-[13px] text-ink-3 sm:right-auto">
                  Nothing departs or arrives in the next {days} days.
                </p>
              ) : (
                model.placed.map((e) => (
                  <Flag
                    key={`${e.shipment.id}-${e.kind}`}
                    event={e}
                    now={now!}
                    dimmed={focusActive && e.shipment.id !== focusId}
                    focused={e.shipment.id === focusId}
                    onFocus={onFocus}
                  />
                ))
              )}
            </div>

            {/* Load: movements per day */}
            <div
              className="grid border-t border-rule-2"
              style={cols}
              aria-label="Movements per day"
            >
              {model.load.map((n, i) => (
                <div
                  key={i}
                  className={`flex h-6 min-w-0 items-center gap-[2px] pl-1.5 ${i > 0 ? "border-l border-rule-3" : ""} ${
                    i === 0 ? "bg-sunken" : ""
                  }`}
                  title={`${n} movement${n === 1 ? "" : "s"}`}
                >
                  {n > 0 ? (
                    <>
                      {Array.from({ length: Math.min(n, LOAD_CELLS) }).map((_, k) => (
                        <span key={k} aria-hidden className="size-[4px] shrink-0 bg-ink-3" />
                      ))}
                      {n > LOAD_CELLS ? (
                        <span className="telemetry ml-0.5 text-[10px] text-ink-2">{n}</span>
                      ) : null}
                      <span className="sr-only">{n}</span>
                    </>
                  ) : null}
                </div>
              ))}
            </div>

            <div className="mt-2.5 flex flex-wrap items-center justify-between gap-x-6 gap-y-1 text-[12px] text-ink-3">
              <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="inline-flex items-center gap-1.5">
                  <Mark filled={false} size={7} />
                  Departure
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Mark filled size={7} />
                  Arrival
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden className="h-2.5 w-px bg-signal" />
                  Now
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden className="inline-flex gap-[2px]">
                    <span className="size-[4px] bg-ink-3" />
                    <span className="size-[4px] bg-ink-3" />
                  </span>
                  Movements per day
                </span>
              </span>
              {model.later > 0 ? (
                <span>
                  {model.later} more beyond {days} days
                </span>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Flag({
  event,
  now,
  dimmed,
  focused,
  onFocus,
}: {
  event: Placed;
  now: number;
  dimmed: boolean;
  focused: boolean;
  onFocus: (id: string | null) => void;
}) {
  const { shipment, kind, at, x, lane, flip, tipFlip } = event;
  const top = BODY_PAD + lane * LANE_PX;
  const verb = kind === "arrival" ? "Arrives" : "Departs";
  const iso = new Date(at).toISOString();
  const port = kind === "arrival" ? shipment.destination : shipment.origin;

  return (
    <div
      className={`group/flag absolute inset-y-0 transition-opacity duration-150 focus-within:z-10 hover:z-10 ${
        dimmed ? "opacity-30" : ""
      }`}
      style={{ left: `${x * 100}%` }}
    >
      {/* Sounding line from the day scale down to the mark */}
      <span
        aria-hidden
        className={`absolute left-0 top-0 w-px ${focused ? "bg-signal" : "bg-rule-1 group-hover/flag:bg-signal"}`}
        style={{ height: top + 7 }}
      />
      <span aria-hidden className="absolute -left-[3.5px]" style={{ top: top + 7 }}>
        <Mark filled={kind === "arrival"} tone={focused ? "signal" : "ink"} size={7} />
      </span>
      <Link
        to="/shipments/$id"
        params={{ id: shipment.id }}
        onMouseEnter={() => onFocus(shipment.id)}
        onMouseLeave={() => onFocus(null)}
        onFocus={() => onFocus(shipment.id)}
        onBlur={() => onFocus(null)}
        aria-label={`${shipment.client_name}, ${shortId(shipment.id)}. ${verb} ${port} ${formatEta(iso)}.`}
        className={`focus-ring absolute flex h-[20px] max-w-[156px] items-center gap-1.5 whitespace-nowrap rounded-[1px] px-1.5 text-[12.5px] ${
          flip ? "right-2 flex-row-reverse" : "left-2"
        }`}
        style={{ top: top + 1 }}
      >
        <span
          className={`truncate ${focused ? "text-signal" : "text-ink-1 group-hover/flag:text-signal"}`}
        >
          {shipment.client_name}
        </span>
        <span className="telemetry shrink-0 text-[10.5px] text-ink-3">
          {kind === "arrival" ? "ETA" : "ETD"}
        </span>
      </Link>

      <div
        role="presentation"
        className={`pointer-events-none invisible absolute z-20 w-[248px] max-w-[80vw] border border-rule-1 bg-paper px-3.5 py-3 opacity-0 group-focus-within/flag:visible group-focus-within/flag:opacity-100 group-hover/flag:visible group-hover/flag:opacity-100 ${
          tipFlip ? "right-0" : "-left-3"
        }`}
        style={{ top: top + 26 }}
      >
        <p className="flex items-baseline justify-between gap-3">
          <span className="truncate text-[13px] font-medium text-ink-1">
            {verb} {port}
          </span>
          <span className="telemetry shrink-0 text-[11px] text-ink-3">
            {tCount(iso, now).label}
          </span>
        </p>
        <p className="mt-0.5 text-[12px] text-ink-3">{formatEta(iso)}</p>
        <p className="mt-2.5 border-t border-rule-2 pt-2.5 text-[13px] text-ink-1">
          {shipment.client_name}
        </p>
        <p className="truncate text-[12px] text-ink-3">
          {shipment.origin} to {shipment.destination}
        </p>
        <p className="telemetry mt-1 truncate text-[11px] text-ink-3">
          {shortId(shipment.id)}
          {shipment.vessel_name ? `  ${shipment.vessel_name}` : ""}
        </p>
      </div>
    </div>
  );
}

/** Events that didn't fit a lane, gathered per day as "+N", listed on
 * hover or keyboard focus. */
function FoldedDay({
  list,
  day,
  days,
  top,
  now,
  plotWidth,
}: {
  list: ScheduleEvent[];
  day: number;
  days: number;
  top: number;
  now: number;
  plotWidth: number;
}) {
  const nearEnd = (day / days) * plotWidth + 240 > plotWidth;
  return (
    <div
      className="group/fold absolute focus-within:z-20 hover:z-20"
      style={{ left: `${(day / days) * 100}%`, top, width: `${100 / days}%` }}
    >
      <button
        type="button"
        aria-label={`${list.length} more on this day: ${list.map((e) => e.shipment.client_name).join(", ")}`}
        className="focus-ring telemetry ml-1 h-[20px] rounded-[1px] px-1.5 text-[11px] text-ink-2 hover:bg-wash hover:text-signal"
      >
        +{list.length}
      </button>
      <div
        role="presentation"
        className={`pointer-events-none invisible absolute top-6 z-20 w-[232px] max-w-[80vw] border border-rule-1 bg-paper px-3.5 py-2.5 opacity-0 group-focus-within/fold:visible group-focus-within/fold:opacity-100 group-hover/fold:visible group-hover/fold:opacity-100 ${
          nearEnd ? "right-0" : "left-0"
        }`}
      >
        <ul className="space-y-1.5">
          {list.map((e) => (
            <li
              key={`${e.shipment.id}-${e.kind}`}
              className="flex items-baseline justify-between gap-3 text-[12.5px]"
            >
              <span className="flex min-w-0 items-center gap-2">
                <Mark filled={e.kind === "arrival"} size={6} />
                <span className="truncate text-ink-1">{e.shipment.client_name}</span>
              </span>
              <span className="telemetry shrink-0 text-[10.5px] text-ink-3">
                {tCount(new Date(e.at).toISOString(), now).label}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function OverdueColumn({ events, now }: { events: ScheduleEvent[]; now: number }) {
  const shown = events.slice(0, 4);
  return (
    <div className="shrink-0 sm:w-[168px] sm:border-r sm:border-rule-1 sm:pr-5">
      {/* Header height matches the day scale so both rules line up */}
      <p className="flex h-[44px] items-end border-b border-rule-1 pb-2 text-[12px] font-medium text-alert">
        Overdue
      </p>
      <ul className="mt-2.5 space-y-2">
        {shown.map((e) => (
          <li key={`${e.shipment.id}-${e.kind}`}>
            <Link
              to="/shipments/$id"
              params={{ id: e.shipment.id }}
              className="focus-ring group flex items-baseline justify-between gap-2 rounded-[1px] text-[12.5px]"
              title={`${e.kind === "arrival" ? "Arrival" : "Departure"} was due ${formatEta(new Date(e.at).toISOString())}`}
            >
              <span className="truncate text-ink-1 group-hover:text-signal">
                {e.shipment.client_name}
              </span>
              <span className="telemetry shrink-0 text-[10.5px] text-alert">
                {e.kind === "arrival" ? "ETA" : "ETD"}{" "}
                {tCount(new Date(e.at).toISOString(), now).label}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {events.length > shown.length ? (
        <p className="mt-2 text-[12px] text-ink-3">{events.length - shown.length} more</p>
      ) : null}
    </div>
  );
}
