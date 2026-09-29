import type { ReactNode } from "react";

import { ACTIVE_STATUSES, type ShipmentStatus } from "@/lib/api";
import { tCount, type ConditionLevel, type TargetState } from "@/components/maritime/format";

/*
 * WhiteWind's maritime marks. A small, fixed vocabulary used the same way
 * everywhere on the dashboard:
 *
 *   AisTarget       the vessel, drawn as an AIS target: filled = active
 *                   (fresh fix, under way), hollow = idle, struck = lost.
 *                   Points along the passage, toward the destination.
 *   ConditionMark   alarm (red diamond) or caution (amber triangle),
 *                   shape and colour both carry the level
 *   ManifestMeter   one cell per required document
 *   TCount          signed time to or since an event, T−8d / T+2d
 *
 * Colour only ever means state: bearing blue under way, amber caution,
 * red alarm, green arrived. Pointing at something is drawn in ink.
 */

/* ------------------------------------------------------------ AIS target --- */

export function AisTarget({
  state,
  stopped = false,
  cursor = false,
  size = 12,
}: {
  state: TargetState;
  stopped?: boolean;
  cursor?: boolean;
  size?: number;
}) {
  if (state === "none") return null;
  const stroke = cursor
    ? "var(--sea-cursor)"
    : state === "active"
      ? "var(--sea-move)"
      : state === "lost"
        ? "var(--sea-ink-4)"
        : stopped
          ? "var(--sea-amber-ink)"
          : "var(--sea-ink-2)";
  const fill =
    state === "active" ? (cursor ? "var(--sea-cursor)" : "var(--sea-move)") : "var(--sea-surface)";
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 12 12"
      className="block overflow-visible"
    >
      <polygon
        points="1.5,1.5 11,6 1.5,10.5"
        fill={fill}
        stroke={stroke}
        strokeWidth="1.4"
        strokeLinejoin="miter"
      />
      {state === "lost" ? (
        <line x1="0" y1="11.5" x2="11.5" y2="0.5" stroke={stroke} strokeWidth="1.2" />
      ) : null}
    </svg>
  );
}

/* -------------------------------------------------------------- passage --- */

/**
 * The WhiteWind passage line, the same everywhere a voyage is drawn:
 * origin ring, track made good (sea blue while AIS confirms the vessel is
 * under way, steel otherwise), the vessel as its AIS target, planned track
 * dotted, destination ring. A ring turns red when its date has passed
 * without the movement being recorded; the destination fills green on
 * arrival.
 */
export function PassageLine({
  pos,
  arrived = false,
  moving = false,
  target = "none",
  stopped = false,
  departOverdue = false,
  arrivalOverdue = false,
  className = "",
}: {
  /** 0..1 along the passage, or null while alongside at origin. */
  pos: number | null;
  arrived?: boolean;
  moving?: boolean;
  target?: TargetState;
  stopped?: boolean;
  departOverdue?: boolean;
  arrivalOverdue?: boolean;
  className?: string;
}) {
  return (
    <span aria-hidden className={`relative mx-[4px] block h-[14px] ${className}`}>
      <span
        className={`absolute inset-x-0 top-1/2 -translate-y-1/2 border-t ${
          arrived ? "border-solid border-ww-steel/60" : "border-dotted border-sea-ink-4"
        }`}
      />
      {pos != null && pos > 0 && !arrived ? (
        <span
          className={`absolute left-0 top-1/2 h-[2px] -translate-y-1/2 rounded-full transition-[width] duration-700 ${
            moving ? "bg-sea-move" : "bg-ww-steel"
          }`}
          style={{ width: `${pos * 100}%` }}
        />
      ) : null}
      <span
        className={`absolute left-0 top-1/2 size-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] ${
          departOverdue
            ? "border-sea-red bg-sea-red"
            : pos == null && !arrived
              ? "border-sea-ink bg-sea-ink"
              : "border-ww-steel bg-sea-surface"
        }`}
      />
      <span
        className={`absolute left-full top-1/2 size-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] ${
          arrived
            ? "border-sea-green bg-sea-green"
            : arrivalOverdue
              ? "border-sea-red bg-sea-surface"
              : "border-sea-ink bg-sea-surface"
        }`}
      />
      {!arrived && pos != null ? (
        <span
          className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 transition-[left] duration-700"
          style={{ left: `${pos * 100}%` }}
        >
          {target === "none" ? (
            <span className="block size-[6px] rotate-45 bg-ww-steel" />
          ) : (
            <AisTarget state={target} stopped={stopped} />
          )}
        </span>
      ) : null}
    </span>
  );
}

/* ---------------------------------------------------------------- phase --- */

/**
 * The lifecycle as six ticks in three groups: port (scheduled, booked),
 * sea (departed, in transit, approaching), port (arrived). Passed phases
 * are solid, the current phase stands taller, phases ahead are hairlines.
 * Phase is geometry, not a coloured badge; only arrival takes colour.
 * A legacy status (at port, cleared, delivered) has passed every phase.
 */
export function PhaseLadder({
  status,
  size = "sm",
  className = "",
}: {
  status: ShipmentStatus;
  size?: "sm" | "md";
  className?: string;
}) {
  const index = ACTIVE_STATUSES.indexOf(status as (typeof ACTIVE_STATUSES)[number]);
  const legacy = index === -1;
  const at = legacy ? ACTIVE_STATUSES.length - 1 : index;
  const h = size === "md" ? { base: 8, cur: 14, w: 4 } : { base: 6, cur: 11, w: 3 };
  return (
    <span
      role="img"
      aria-label={`Phase ${at + 1} of ${ACTIVE_STATUSES.length}: ${status}`}
      className={`inline-flex shrink-0 items-end ${className}`}
      style={{ height: h.cur }}
    >
      {ACTIVE_STATUSES.map((p, i) => {
        const passed = i < at || legacy;
        const current = i === at && !legacy;
        const arrived = p === "Arrived" && (current || legacy);
        return (
          <span
            key={p}
            aria-hidden
            className={`rounded-[1px] ${arrived ? "bg-sea-green" : current ? "bg-ww-blue" : passed ? "bg-ww-steel/60" : "bg-sea-rule"}`}
            style={{
              width: h.w,
              height: current || arrived ? h.cur : h.base,
              marginLeft: i === 0 ? 0 : i === 2 || i === 5 ? h.w + 2 : 2,
            }}
          />
        );
      })}
    </span>
  );
}

/* -------------------------------------------------------------- bearing --- */

/** Course over ground as a small arrow, north up, rotated to the bearing. */
export function Bearing({
  deg,
  className = "",
  size = 10,
}: {
  deg: number | null;
  className?: string;
  size?: number;
}) {
  if (deg == null) return null;
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 10 10"
      className={`inline-block shrink-0 ${className}`}
      style={{ transform: `rotate(${deg}deg)` }}
    >
      <path d="M5 0.8 L8.2 8.6 L5 6.8 L1.8 8.6 Z" fill="currentColor" />
    </svg>
  );
}

/** Source of a logged entry, by shape: AIS a filled triangle (a target),
 * system a filled square, operator a hollow square. */
export function SourceMark({ source, automated }: { source: string; automated: boolean }) {
  if (source === "ais")
    return (
      <svg aria-hidden width="8" height="8" viewBox="0 0 8 8" className="block shrink-0">
        <polygon points="0.8,0.8 7.4,4 0.8,7.2" fill="var(--sea-ink-2)" />
      </svg>
    );
  return (
    <span
      aria-hidden
      className={`inline-block size-[7px] shrink-0 ${automated ? "bg-sea-ink-2" : "border-[1.5px] border-sea-ink-2"}`}
    />
  );
}

/* ------------------------------------------------------------ condition --- */

export function ConditionMark({ level, size = 9 }: { level: ConditionLevel; size?: number }) {
  if (level === "alarm") {
    return (
      <span
        aria-hidden
        className="inline-block shrink-0 rotate-45 bg-sea-red"
        style={{ width: size * 0.78, height: size * 0.78 }}
      />
    );
  }
  return (
    <svg aria-hidden width={size + 1} height={size} viewBox="0 0 10 9" className="block shrink-0">
      <polygon points="5,0.5 9.6,8.5 0.4,8.5" fill="var(--sea-amber)" />
    </svg>
  );
}

/* ------------------------------------------------------------- manifest --- */

export function ManifestMeter({ attached, total }: { attached: number; total: number }) {
  const complete = attached >= total;
  return (
    <span
      className="inline-flex items-center gap-2 whitespace-nowrap"
      title={`${attached} of ${total} documents attached`}
    >
      <span aria-hidden className="inline-flex gap-[2px]">
        {Array.from({ length: total }).map((_, i) => (
          <span
            key={i}
            className={`h-[9px] w-[4px] ${
              i < attached
                ? complete
                  ? "bg-sea-green"
                  : "bg-sea-ink-2"
                : "border border-sea-rule bg-transparent"
            }`}
          />
        ))}
      </span>
      <span className={`telemetry text-[10.5px] ${complete ? "text-sea-ink-3" : "text-sea-ink"}`}>
        {attached}/{total}
      </span>
    </span>
  );
}

/* ----------------------------------------------------------------- time --- */

export function TCount({
  iso,
  now,
  className = "",
}: {
  iso: string;
  now: number | null;
  className?: string;
}) {
  if (now == null) return null;
  const { label, past } = tCount(iso, now);
  return (
    <span
      className={`telemetry text-[10.5px] uppercase ${past ? "font-medium text-sea-red" : "text-sea-ink-3"} ${className}`}
      title={past ? "Time since this date" : "Time until this date"}
    >
      {label}
    </span>
  );
}

/* --------------------------------------------------------------- layout --- */

/**
 * A chart panel: a condensed title set on a ruled head, like the title
 * block of a chart or a panel on a console. No box; the rule is the frame.
 */
export function ChartPanel({
  id,
  title,
  meta,
  tools,
  children,
  className = "",
  flush = false,
  quiet = false,
}: {
  id: string;
  title: string;
  meta?: ReactNode;
  tools?: ReactNode;
  children: ReactNode;
  className?: string;
  /** The body runs to the panel edges (a table that draws its own gutters). */
  flush?: boolean;
  /** Context rather than operations: no surface, a title over a hairline,
   * so it recedes beside the panels that hold live work. */
  quiet?: boolean;
}) {
  if (quiet)
    return (
      <section
        id={id}
        aria-labelledby={`${id}-title`}
        className={`min-w-0 scroll-mt-[calc(var(--rail-h)+16px)] ${className}`}
      >
        <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-sea-rule pb-2.5">
          <div className="flex min-w-0 items-baseline gap-2.5">
            <h2 id={`${id}-title`} className="text-[13.5px] font-semibold text-sea-ink">
              {title}
            </h2>
            {meta ? <span className="truncate text-[12px] text-sea-ink-3">{meta}</span> : null}
          </div>
          {tools ? <div className="min-w-0 max-w-full">{tools}</div> : null}
        </header>
        {children}
      </section>
    );
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={`panel min-w-0 overflow-hidden scroll-mt-[calc(var(--rail-h)+16px)] ${className}`}
    >
      <header className="flex min-h-[52px] flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-sea-rule px-4 py-2.5 sm:px-5">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <h2 id={`${id}-title`} className="panel-title">
            {title}
          </h2>
          {meta ? <span className="truncate text-[12px] text-sea-ink-3">{meta}</span> : null}
        </div>
        {tools ? <div className="min-w-0 max-w-full">{tools}</div> : null}
      </header>
      <div
        className={
          flush ? "" : "px-4 pb-1 sm:px-5 [&_li:last-child]:border-b-0 [&_tr:last-child]:border-b-0"
        }
      >
        {children}
      </div>
    </section>
  );
}

/** Placeholder in the chart's own neutral, square like everything else. */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse bg-sea-paper-2 ${className}`} />;
}
