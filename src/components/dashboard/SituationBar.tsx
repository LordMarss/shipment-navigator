import { Plus, X } from "lucide-react";
import type { ReactNode } from "react";

import type { Shipment } from "@/lib/api";
import { relativeTime } from "@/lib/lifecycle";
import { clock, monthName, shortDate, utcClock, weekday } from "@/components/maritime/format";
import { ConditionMark } from "@/components/maritime/marks";
import type { Lens } from "@/components/maritime/VoyageBoard";

export type SituationFacts = {
  alarm: number;
  caution: number;
  underway: number;
  inPassage: number;
  arriving72h: number;
  etaRevised24h: number;
  docsOpen: number;
  overdueDepartures: number;
  nextArrival: Shipment | null;
  /** The most recent logged change, for the "Changed" reading. */
  latestChange: { at: number; client: string | null } | null;
};

/**
 * The watch summary that opens the operations page. One statement leads
 * (how many voyages need intervention, and why) and three readings follow,
 * each answering one question a watch officer asks: what is moving, what
 * is arriving, what has changed. The readings are also the board's lenses:
 * selecting one filters the board below, so the summary and the board can
 * never tell two different stories.
 */
export function SituationBar({
  facts,
  now,
  lastSync,
  isLoading,
  lens,
  onLens,
  formOpen,
  onToggleForm,
}: {
  facts: SituationFacts;
  now: number | null;
  lastSync: string | undefined;
  isLoading: boolean;
  lens: Lens;
  onLens: (lens: Lens) => void;
  formOpen: boolean;
  onToggleForm: () => void;
}) {
  const need = facts.alarm + facts.caution;
  const pick = (l: Lens) => onLens(lens === l ? "all" : l);

  return (
    <section aria-labelledby="situation-title" className="border-b border-sea-rule">
      <h1 id="situation-title" className="sr-only">
        Operations
      </h1>
      <div className="mx-auto w-full max-w-[1600px] px-4 sm:px-6 lg:px-8">
        {/* Watch line: date, local time, monitor state, and the one action */}
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-sea-rule-2 py-2.5">
          <p className="telemetry text-[11px] text-sea-ink-3">
            {now != null ? (
              <>
                <span className="text-sea-ink-2">
                  {weekday(now)} {new Date(now).getDate()} {monthName(now)}
                </span>
                <span className="ml-3">{utcClock(now)} UTC</span>
                <span className="ml-3">{clock(now)} local</span>
              </>
            ) : (
              <span className="inline-block h-3 w-40 animate-pulse bg-sea-paper-2 align-middle" />
            )}
            <span className="ml-3 hidden sm:inline">
              AIS monitor{" "}
              {isLoading ? "" : lastSync ? `ran ${relativeTime(lastSync)}` : "has not run"}
            </span>
          </p>
          <button
            type="button"
            onClick={onToggleForm}
            aria-expanded={formOpen}
            className={`focus-ring inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[2px] px-3 text-[13px] font-medium transition-colors duration-150 active:translate-y-px ${
              formOpen
                ? "border border-sea-rule bg-sea-surface text-sea-ink hover:bg-sea-paper-2"
                : "bg-sea-ink text-sea-surface hover:bg-sea-ink-2"
            }`}
          >
            {formOpen ? (
              <X className="size-3.5" aria-hidden />
            ) : (
              <Plus className="size-3.5" aria-hidden />
            )}
            {formOpen ? "Close form" : "New shipment"}
          </button>
        </div>

        <div className="grid grid-cols-3 gap-x-4 py-5 lg:grid-cols-[minmax(0,1.5fr)_repeat(3,minmax(0,1fr))] lg:gap-x-0">
          {/* The lead: what needs intervention */}
          <button
            type="button"
            onClick={() => pick("attention")}
            aria-pressed={lens === "attention"}
            className="focus-ring group col-span-3 mb-5 text-left lg:col-span-1 lg:mb-0 lg:pr-8"
          >
            <span className="chart-label block text-sea-ink-3">Needs intervention</span>
            {isLoading ? (
              <span className="mt-2 block h-10 w-64 max-w-full animate-pulse bg-sea-paper-2" />
            ) : (
              <>
                <span className="mt-1 flex items-center gap-3">
                  <span
                    className={`figure text-[52px] leading-[52px] ${need > 0 ? "text-sea-ink" : "text-sea-ink-3"}`}
                  >
                    {need}
                  </span>
                  <span className="flex flex-col gap-1 text-[12.5px] leading-[16px]">
                    <span className="flex items-center gap-1.5 text-sea-ink">
                      <ConditionMark level="alarm" size={8} />
                      <span className="telemetry text-[11px]">{facts.alarm}</span> in alarm
                    </span>
                    <span className="flex items-center gap-1.5 text-sea-ink">
                      <ConditionMark level="caution" size={8} />
                      <span className="telemetry text-[11px]">{facts.caution}</span> on caution
                    </span>
                  </span>
                </span>
                <span className="mt-2 block max-w-[48ch] text-[13px] leading-[1.45] text-sea-ink-2">
                  {lead(facts)}
                </span>
                <LensHint on={lens === "attention"} />
              </>
            )}
          </button>

          <Reading
            label="At sea"
            value={facts.underway}
            unit="under way"
            detail={`${facts.inPassage} in passage`}
            tone="move"
            on={lens === "underway"}
            onClick={() => pick("underway")}
            isLoading={isLoading}
          />
          <Reading
            label="Arriving"
            value={facts.arriving72h}
            unit="within 72h"
            detail={
              facts.nextArrival?.eta && now != null
                ? `Next ${facts.nextArrival.destination}, ${shortDate(facts.nextArrival.eta, now)}`
                : "No arrivals scheduled"
            }
            on={lens === "arriving"}
            onClick={() => pick("arriving")}
            isLoading={isLoading}
          />
          <Reading
            label="Changed"
            value={facts.etaRevised24h}
            unit="ETA revised 24h"
            detail={
              facts.latestChange
                ? `Last logged ${clock(facts.latestChange.at)}${facts.latestChange.client ? `, ${facts.latestChange.client}` : ""}`
                : "Nothing logged yet"
            }
            tone={facts.etaRevised24h > 0 ? "caution" : undefined}
            on={lens === "changed"}
            onClick={() => pick("changed")}
            isLoading={isLoading}
          />
        </div>
      </div>
    </section>
  );
}

function lead(f: SituationFacts) {
  const parts: string[] = [];
  if (f.overdueDepartures > 0)
    parts.push(`${f.overdueDepartures} departure${f.overdueDepartures === 1 ? "" : "s"} overdue`);
  if (f.docsOpen > 0) parts.push(`${f.docsOpen} with documents outstanding`);
  if (f.alarm + f.caution === 0) return "Every voyage is on schedule with its documents in order.";
  return parts.length > 0
    ? `${parts.join(", ")}. Most urgent first on the board below.`
    : "Most urgent first on the board below.";
}

function Reading({
  label,
  value,
  unit,
  detail,
  tone,
  on,
  onClick,
  isLoading,
}: {
  label: string;
  value: number;
  unit: string;
  detail: ReactNode;
  tone?: "move" | "caution" | undefined;
  on: boolean;
  onClick: () => void;
  isLoading: boolean;
}) {
  const color =
    value === 0
      ? "text-sea-ink-4"
      : tone === "move"
        ? "text-sea-move"
        : tone === "caution"
          ? "text-sea-amber-ink"
          : "text-sea-ink";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className="focus-ring group min-w-0 border-l border-sea-rule-2 pl-3 text-left max-lg:[&:nth-child(2)]:border-l-0 max-lg:[&:nth-child(2)]:pl-0 lg:pl-6"
    >
      <span className="chart-label block text-sea-ink-3">{label}</span>
      {isLoading ? (
        <span className="mt-2 block h-8 w-12 animate-pulse bg-sea-paper-2" />
      ) : (
        <>
          <span className="mt-1 flex items-baseline gap-2">
            <span className={`figure text-[34px] leading-[38px] ${color}`}>{value}</span>
            <span className="hidden text-[12px] text-sea-ink-2 sm:inline">{unit}</span>
          </span>
          <span className="text-[12px] text-sea-ink-2 sm:hidden">{unit}</span>
          <span className="mt-0.5 block truncate text-[12px] text-sea-ink-3">{detail}</span>
          <LensHint on={on} />
        </>
      )}
    </button>
  );
}

/** Shows whether this reading is the board's current lens. */
function LensHint({ on }: { on: boolean }) {
  return (
    <span
      className={`mt-2 hidden items-center gap-1.5 text-[11.5px] transition-colors sm:flex ${
        on ? "text-sea-ink" : "text-sea-ink-4 group-hover:text-sea-ink-3"
      }`}
    >
      <span
        aria-hidden
        className={`h-[2px] w-4 transition-colors ${on ? "bg-sea-ink" : "bg-sea-rule group-hover:bg-sea-ink-4"}`}
      />
      {on ? "Showing on board" : "Show on board"}
    </span>
  );
}
