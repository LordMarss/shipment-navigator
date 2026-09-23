import type { ReactNode } from "react";

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
      className={`telemetry text-[10.5px] ${past ? "font-medium text-sea-red" : "text-sea-ink-3"} ${className}`}
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
}: {
  id: string;
  title: string;
  meta?: ReactNode;
  tools?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={`min-w-0 scroll-mt-[calc(var(--rail-h)+16px)] ${className}`}
    >
      <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-sea-ink pb-2">
        <div className="flex min-w-0 items-baseline gap-3">
          <h2 id={`${id}-title`} className="chart-label !text-[11.5px] text-sea-ink">
            {title}
          </h2>
          {meta ? (
            <span className="telemetry truncate text-[11px] text-sea-ink-3">{meta}</span>
          ) : null}
        </div>
        {tools ? <div className="min-w-0 max-w-full">{tools}</div> : null}
      </header>
      {children}
    </section>
  );
}

/** Placeholder in the chart's own neutral, square like everything else. */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse bg-sea-paper-2 ${className}`} />;
}
