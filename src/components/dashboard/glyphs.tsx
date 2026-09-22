import type { ReactNode } from "react";

import type { ShipmentStatus } from "@/lib/api";
import { tCount, type Signal } from "@/components/dashboard/format";

/*
 * WhiteWind instrument glyphs. One geometric system, drawn on a shared
 * 2px grid with square cells and no rounding:
 *
 *   PhaseMeter   five tall ticks: lifecycle progression; the current phase
 *                stands a step taller than the ones already passed
 *   SignalBars   four stepped bars: recency of the last AIS fix
 *   DocsMeter    one small square per required document
 *   Mark         square point marker: filled = automatic / arrival,
 *                hollow = operator / departure
 *   TCount       signed time offset in telemetry type
 *
 * Every glyph is neutral by default. Colour appears only where the state
 * means something: blue for movement or live signal, green for a
 * confirmed completion, amber and red only for problems. An unlit cell
 * is always the same `off` grey, so "empty" reads the same everywhere.
 */

/* ---------------------------------------------------------------- phase --- */

type PhaseFamily = "pending" | "moving" | "done" | "held";

const PHASE: Record<ShipmentStatus, { step: number; family: PhaseFamily }> = {
  Scheduled: { step: 1, family: "pending" },
  Booked: { step: 1, family: "pending" },
  Departed: { step: 2, family: "moving" },
  "In Transit": { step: 3, family: "moving" },
  "Approaching Destination": { step: 4, family: "moving" },
  Arrived: { step: 5, family: "done" },
  "At Port": { step: 5, family: "held" },
  "Cleared Customs": { step: 5, family: "done" },
  Delivered: { step: 5, family: "done" },
};

const FAMILY_FILL: Record<PhaseFamily, string> = {
  pending: "bg-ink-3",
  moving: "bg-signal",
  done: "bg-confirm",
  held: "bg-caution",
};

export function PhaseMeter({ status }: { status: ShipmentStatus }) {
  const { step, family } = PHASE[status] ?? { step: 1, family: "pending" as const };
  return (
    <span aria-hidden className="inline-flex h-[10px] shrink-0 items-end gap-[2px]">
      {Array.from({ length: 5 }).map((_, i) => {
        const lit = i < step;
        const current = i === step - 1;
        return (
          <span
            key={i}
            className={`w-[3px] ${current ? "h-[10px]" : "h-[8px]"} ${lit ? FAMILY_FILL[family] : "bg-off"}`}
          />
        );
      })}
    </span>
  );
}

export function PhaseLabel({
  status,
  className = "",
}: {
  status: ShipmentStatus;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-2.5 whitespace-nowrap ${className}`}>
      <PhaseMeter status={status} />
      <span>{status === "Approaching Destination" ? "Approaching" : status}</span>
    </span>
  );
}

/* --------------------------------------------------------------- signal --- */

/** Stepped bars like a receiver's strength meter. Bars carry the meaning
 * (4 = fix under an hour old, 1 = stale, 0 = nothing); blue only when the
 * vessel is confirmed moving. */
export function SignalBars({ signal, moving = false }: { signal: Signal; moving?: boolean }) {
  const tone = signal.state === "stale" ? "bg-ink-3" : moving ? "bg-signal" : "bg-ink-1";
  return (
    <span aria-hidden className="inline-flex h-[10px] shrink-0 items-end gap-[2px]">
      {[4, 6, 8, 10].map((h, i) => (
        <span
          key={h}
          className={`w-[2px] ${i < signal.bars ? tone : "bg-off"}`}
          style={{ height: h }}
        />
      ))}
    </span>
  );
}

/* ----------------------------------------------------------------- docs --- */

export function DocsMeter({ attached, total }: { attached: number; total: number }) {
  const complete = attached >= total;
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <span aria-hidden className="inline-flex gap-[2px]">
        {Array.from({ length: total }).map((_, i) => (
          <span
            key={i}
            className={`size-[5px] ${i < attached ? (complete ? "bg-confirm" : "bg-ink-2") : "bg-off"}`}
          />
        ))}
      </span>
      <span className={`telemetry text-[11.5px] ${complete ? "text-ink-3" : "text-ink-1"}`}>
        {attached}/{total}
      </span>
    </span>
  );
}

/* ----------------------------------------------------------------- mark --- */

export function Mark({
  filled,
  tone = "ink",
  size = 7,
  className = "",
}: {
  filled: boolean;
  tone?: "ink" | "quiet" | "signal" | "alert" | "caution";
  size?: number;
  className?: string;
}) {
  const color = {
    ink: filled ? "bg-ink-1" : "border-ink-1",
    quiet: filled ? "bg-ink-3" : "border-ink-3",
    signal: filled ? "bg-signal" : "border-signal",
    alert: filled ? "bg-alert" : "border-alert",
    caution: filled ? "bg-caution" : "border-caution",
  }[tone];
  return (
    <span
      aria-hidden
      className={`inline-block shrink-0 ${filled ? color : `border-[1.5px] bg-paper ${color}`} ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

/* ----------------------------------------------------------------- time --- */

export function TCount({
  iso,
  now,
  overdueTone = true,
}: {
  iso: string;
  now: number | null;
  overdueTone?: boolean;
}) {
  if (now == null) return null;
  const { label, past } = tCount(iso, now);
  return (
    <span
      className={`telemetry text-[11px] ${past && overdueTone ? "font-medium text-alert" : "text-ink-3"}`}
      title={past ? "Time since this date" : "Time until this date"}
    >
      {label}
    </span>
  );
}

/* -------------------------------------------------------------- loading --- */

/** Placeholder in the sheet's own neutral, square like everything else. */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse bg-wash ${className}`} />;
}

/* --------------------------------------------------------------- layout --- */

/**
 * One ruled band of the operations sheet: a rule across the full width,
 * the section's title in the left margin, and its content on the working
 * column. Below xl the margin folds into a header row above the content.
 */
export function Band({
  id,
  title,
  meta,
  aside,
  children,
}: {
  id: string;
  title: string;
  meta?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={`${id}-title`}
      id={id}
      className="grid scroll-mt-16 grid-cols-[minmax(0,1fr)] border-t border-rule-1 xl:grid-cols-[var(--ww-margin)_minmax(0,1fr)]"
    >
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-3 pb-4 pt-4 xl:flex-col xl:items-stretch xl:gap-y-5 xl:pb-8 xl:pr-10 xl:pt-5">
        <div className="mr-auto xl:mr-0">
          <h2 id={`${id}-title`} className="text-[13px] font-semibold text-ink-1">
            {title}
          </h2>
          {meta ? <div className="mt-1 text-[12px] leading-[1.4] text-ink-3">{meta}</div> : null}
        </div>
        {aside ? (
          <div className="w-full min-w-0 max-w-full sm:w-auto xl:w-full">{aside}</div>
        ) : null}
      </header>
      <div className="min-w-0 pb-10 xl:pt-5">{children}</div>
    </section>
  );
}
