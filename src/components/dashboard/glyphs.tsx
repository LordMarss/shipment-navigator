import type { ReactNode } from "react";

import type { ShipmentStatus } from "@/lib/api";
import { tCount, type SignalState } from "@/components/dashboard/format";

/*
 * WhiteWind's small instrument vocabulary. Each glyph encodes one fact the
 * same way everywhere on the dashboard, so a coordinator learns the shape
 * once and then reads it without the label:
 *
 *   PhaseMeter   where a shipment is in its lifecycle (5 segments)
 *   SignalGlyph  how fresh the vessel's AIS position is (3 bars)
 *   DocsMeter    how many required documents are attached (1 segment each)
 *   TCount       time to (T−) or since (T+) an event, in one notation
 */

/* ---------------------------------------------------------------- phase --- */

const PHASE: Record<ShipmentStatus, { step: number; tone: string }> = {
  Scheduled: { step: 1, tone: "bg-foreground/55" },
  Booked: { step: 1, tone: "bg-foreground/55" },
  Departed: { step: 2, tone: "bg-primary" },
  "In Transit": { step: 3, tone: "bg-primary" },
  "Approaching Destination": { step: 4, tone: "bg-primary" },
  Arrived: { step: 5, tone: "bg-positive" },
  "At Port": { step: 5, tone: "bg-warning" },
  "Cleared Customs": { step: 5, tone: "bg-positive" },
  Delivered: { step: 5, tone: "bg-positive" },
};

/** Booked → Departed → In Transit → Approaching → Arrived, filled to the
 * current phase. Colour follows the phase family (not yet moving / under
 * way / arrived), never the individual status. */
export function PhaseMeter({ status }: { status: ShipmentStatus }) {
  const { step, tone } = PHASE[status] ?? { step: 1, tone: "bg-foreground/55" };
  return (
    <span aria-hidden className="inline-flex shrink-0 items-center gap-[2px]">
      {Array.from({ length: 5 }).map((_, i) => (
        <span
          key={i}
          className={`h-[9px] w-[4px] rounded-[1px] ${i < step ? tone : "bg-foreground/12"}`}
        />
      ))}
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
    <span className={`inline-flex items-center gap-2 whitespace-nowrap ${className}`}>
      <PhaseMeter status={status} />
      <span>{status === "Approaching Destination" ? "Approaching" : status}</span>
    </span>
  );
}

/* --------------------------------------------------------------- signal --- */

/** AIS reception, drawn as signal bars: three when the latest position is
 * fresh, one when a position exists but has gone stale, none otherwise. */
export function SignalGlyph({ state, moving = false }: { state: SignalState; moving?: boolean }) {
  const lit = state === "live" ? 3 : state === "stale" ? 1 : 0;
  const tone = state === "live" ? "bg-primary" : "bg-foreground/45";
  return (
    <span
      aria-hidden
      className={`inline-flex h-[10px] shrink-0 items-end gap-[2px] ${moving ? "live-pulse" : ""}`}
    >
      {[4, 7, 10].map((h, i) => (
        <span
          key={h}
          className={`w-[2px] rounded-[1px] ${i < lit ? tone : "bg-foreground/15"}`}
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
            className={`h-[3px] w-[7px] rounded-[1px] ${
              i < attached ? (complete ? "bg-positive" : "bg-foreground/60") : "bg-foreground/15"
            }`}
          />
        ))}
      </span>
      <span className={`tabular-nums ${complete ? "text-muted-foreground" : "text-foreground"}`}>
        {attached}/{total}
      </span>
    </span>
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
      className={`instrument text-[11px] ${past && overdueTone ? "font-medium text-risk" : "text-muted-foreground"}`}
      title={past ? "Time since this date" : "Time until this date"}
    >
      {label}
    </span>
  );
}

/* --------------------------------------------------------------- layout --- */

/**
 * One ruled band of the operations sheet: a hairline across the full width,
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
      className="grid scroll-mt-16 grid-cols-[minmax(0,1fr)] border-t border-foreground/15 xl:grid-cols-[var(--ww-margin)_minmax(0,1fr)]"
    >
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-3 pb-4 pt-5 xl:flex-col xl:items-stretch xl:gap-y-4 xl:pb-8 xl:pr-10 xl:pt-6">
        <div className="mr-auto xl:mr-0">
          <h2
            id={`${id}-title`}
            className="text-[15px] font-semibold tracking-[-0.01em] text-foreground"
          >
            {title}
          </h2>
          {meta ? <div className="mt-1 text-xs text-muted-foreground">{meta}</div> : null}
        </div>
        {aside ? (
          <div className="w-full min-w-0 max-w-full sm:w-auto xl:w-full">{aside}</div>
        ) : null}
      </header>
      <div className="min-w-0 pb-10 xl:pb-10 xl:pt-6">{children}</div>
    </section>
  );
}
