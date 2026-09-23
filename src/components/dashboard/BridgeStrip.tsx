import { Plus, X } from "lucide-react";

import type { Shipment } from "@/lib/api";
import { relativeTime } from "@/lib/lifecycle";
import { clock, monthName, shortDate, utcClock, weekday } from "@/components/maritime/format";
import { ConditionMark } from "@/components/maritime/marks";

export type BridgeFacts = {
  alarm: number;
  caution: number;
  underway: number;
  inPassage: number;
  arriving72h: number;
  etaRevised24h: number;
  docsOpen: number;
  overdueDepartures: number;
  nextArrival: Shipment | null;
};

/**
 * The bridge console: the one dark surface on the dashboard, continuous with
 * the navigation chrome above and beside it. It holds what a watch officer
 * checks first: the time (UTC and local), the standing alert counts in the
 * bridge's alarm / caution vocabulary, one sentence on the situation, and
 * the instrument readouts.
 */
export function BridgeStrip({
  facts,
  now,
  lastSync,
  isLoading,
  formOpen,
  onToggleForm,
}: {
  facts: BridgeFacts;
  now: number | null;
  lastSync: string | undefined;
  isLoading: boolean;
  formOpen: boolean;
  onToggleForm: () => void;
}) {
  return (
    <section aria-label="Bridge summary" className="bg-sea-console text-sea-console-ink">
      <h1 className="sr-only">Operations</h1>
      <div className="mx-auto w-full max-w-[1560px] px-5 sm:px-8 lg:px-10">
        <div className="grid gap-x-10 gap-y-5 py-6 md:grid-cols-[auto_minmax(0,1fr)_auto] md:items-start">
          {/* Time */}
          <div className="flex items-baseline gap-4 md:block md:border-r md:border-sea-console-line md:pr-10">
            {now != null ? (
              <>
                <p className="telemetry text-[30px] font-light leading-none tracking-[-0.02em] text-sea-console-ink">
                  {utcClock(now)}
                  <span className="chart-label ml-2 align-top !text-[10px] text-sea-console-ink-2">
                    UTC
                  </span>
                </p>
                <p className="chart-label mt-2 text-sea-console-ink-2">
                  {weekday(now)} {new Date(now).getDate()} {monthName(now)}{" "}
                  {new Date(now).getFullYear()}
                  <span className="ml-2 text-sea-console-ink">{clock(now)} LT</span>
                </p>
              </>
            ) : (
              <span className="block h-8 w-28 animate-pulse bg-sea-console-2" />
            )}
          </div>

          {/* Situation */}
          <div className="min-w-0">
            {isLoading || now == null ? (
              <div className="space-y-2.5">
                <span className="block h-6 w-[min(24rem,90%)] animate-pulse bg-sea-console-2" />
                <span className="block h-4 w-[min(32rem,95%)] animate-pulse bg-sea-console-2" />
              </div>
            ) : (
              <>
                <p className="text-[21px] font-medium leading-[1.25] tracking-[-0.01em] text-sea-console-ink">
                  {headline(facts)}
                </p>
                <p className="mt-1.5 max-w-[70ch] text-[13.5px] leading-[1.5] text-sea-console-ink-2">
                  {summary(facts, now)}
                </p>
              </>
            )}
          </div>

          <button
            type="button"
            onClick={onToggleForm}
            aria-expanded={formOpen}
            className={`focus-ring inline-flex h-8 shrink-0 items-center gap-1.5 self-start rounded-[2px] px-3 text-[13px] font-medium transition-colors duration-150 active:translate-y-px ${
              formOpen
                ? "border border-sea-console-line text-sea-console-ink hover:bg-sea-console-2"
                : "bg-sea-move-bright text-sea-console hover:bg-[color-mix(in_oklab,var(--sea-move-bright)_85%,white)]"
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

        {/* Instrument readouts */}
        <div className="grid grid-cols-4 lg:grid-cols-8 lg:border-t lg:border-sea-console-line">
          <Alert label="Alarm" value={facts.alarm} level="alarm" isLoading={isLoading} />
          <Alert label="Caution" value={facts.caution} level="caution" isLoading={isLoading} />
          <Readout
            label="Under way"
            value={facts.underway}
            isLoading={isLoading}
            tone="text-sea-move-bright"
          />
          <Readout label="In passage" value={facts.inPassage} isLoading={isLoading} />
          <Readout label="Arr ≤72h" value={facts.arriving72h} isLoading={isLoading} />
          <Readout label="ETA rev 24h" value={facts.etaRevised24h} isLoading={isLoading} />
          <Readout label="Docs open" value={facts.docsOpen} isLoading={isLoading} />
          <div className="border-l border-t border-sea-console-line px-3 py-3 lg:border-t-0">
            <p className="chart-label text-sea-console-ink-2">AIS monitor</p>
            <p className="telemetry mt-1.5 text-[13px] text-sea-console-ink">
              {isLoading ? (
                <span className="inline-block h-4 w-12 animate-pulse bg-sea-console-2" />
              ) : lastSync ? (
                relativeTime(lastSync)
              ) : (
                "No run yet"
              )}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function headline(f: BridgeFacts) {
  if (f.alarm > 0) {
    return `${f.alarm} shipment${f.alarm === 1 ? "" : "s"} in alarm${
      f.caution > 0 ? `, ${f.caution} on caution` : ""
    }.`;
  }
  if (f.caution > 0)
    return `No alarms. ${f.caution} shipment${f.caution === 1 ? "" : "s"} on caution.`;
  return "No alarms. Every shipment is on schedule.";
}

function summary(f: BridgeFacts, now: number) {
  const parts: string[] = [];
  if (f.overdueDepartures > 0) {
    parts.push(
      `${f.overdueDepartures} departure${f.overdueDepartures === 1 ? " is" : "s are"} overdue`,
    );
  }
  if (f.nextArrival?.eta) {
    parts.push(
      `next arrival ${f.nextArrival.client_name} into ${f.nextArrival.destination} on ${shortDate(f.nextArrival.eta, now)}`,
    );
  }
  parts.push(
    f.underway > 0
      ? `${f.underway} vessel${f.underway === 1 ? "" : "s"} under way on AIS`
      : "no vessel under way on AIS",
  );
  const text = parts.join(", ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

function Readout({
  label,
  value,
  isLoading,
  tone,
}: {
  label: string;
  value: number;
  isLoading: boolean;
  tone?: string;
}) {
  return (
    <div className="border-l border-t border-sea-console-line px-3 py-3 first:border-l-0 [&:nth-child(4n+1)]:border-l-0 lg:border-t-0 lg:[&:nth-child(4n+1)]:border-l lg:first:!border-l-0">
      <p className="chart-label text-sea-console-ink-2">{label}</p>
      <p
        className={`telemetry mt-1 text-[20px] leading-none ${
          isLoading
            ? ""
            : value === 0
              ? "text-sea-console-ink-2/70"
              : (tone ?? "text-sea-console-ink")
        }`}
      >
        {isLoading ? (
          <span className="inline-block h-5 w-6 animate-pulse bg-sea-console-2" />
        ) : (
          value
        )}
      </p>
    </div>
  );
}

function Alert({
  label,
  value,
  level,
  isLoading,
}: {
  label: string;
  value: number;
  level: "alarm" | "caution";
  isLoading: boolean;
}) {
  const lit = !isLoading && value > 0;
  return (
    <a
      href="#conditions"
      className={`focus-ring group block border-l border-t border-sea-console-line px-3 py-3 first:border-l-0 lg:border-t-0 ${
        lit ? (level === "alarm" ? "bg-sea-red/15" : "bg-sea-amber/10") : ""
      } hover:bg-sea-console-2`}
    >
      <p className="chart-label flex items-center gap-1.5 text-sea-console-ink-2">
        {lit ? <ConditionMark level={level} size={8} /> : null}
        {label}
      </p>
      <p
        className={`telemetry mt-1 text-[20px] leading-none ${
          !lit
            ? "text-sea-console-ink-2/70"
            : level === "alarm"
              ? "text-sea-red-bright"
              : "text-sea-amber"
        }`}
      >
        {isLoading ? (
          <span className="inline-block h-5 w-6 animate-pulse bg-sea-console-2" />
        ) : (
          value
        )}
      </p>
    </a>
  );
}
