import { Plus, X } from "lucide-react";

import type { Shipment } from "@/lib/api";
import { relativeTime } from "@/lib/lifecycle";

import { shortDate } from "@/components/dashboard/format";
import { Mark, Skeleton } from "@/components/dashboard/glyphs";

export type MastheadFacts = {
  exceptions: number;
  toReview: number;
  overdueDepartures: number;
  nextArrival: Shipment | null;
  underway: number;
  active: number;
  arriving72h: number;
  etaRevised24h: number;
  missingDocs: number;
};

/**
 * The top of the sheet reads like a watch report rather than a row of
 * tiles: the date, one sentence saying what needs a person, one sentence
 * of context, then the standing readings on a single ruled line. The only
 * colour is the count of shipments with an immediate problem.
 */
export function Masthead({
  facts,
  now,
  lastSync,
  isLoading,
  formOpen,
  onToggleForm,
}: {
  facts: MastheadFacts;
  now: number | null;
  lastSync: string | undefined;
  isLoading: boolean;
  formOpen: boolean;
  onToggleForm: () => void;
}) {
  const date = now == null ? null : new Date(now);

  return (
    <header className="grid grid-cols-[minmax(0,1fr)] pb-1 pt-7 xl:grid-cols-[var(--ww-margin)_minmax(0,1fr)] xl:pt-9">
      <h1 className="sr-only">Operations</h1>

      {/* Log-page date, in the margin */}
      <div className="mb-5 flex flex-wrap items-baseline gap-x-3 gap-y-1 xl:mb-0 xl:block xl:pr-10">
        {date ? (
          <>
            <p className="text-[14px] font-medium text-ink-1 xl:text-[44px] xl:font-normal xl:leading-[0.9] xl:tracking-[-0.035em] xl:tabular-nums">
              <span className="xl:hidden">
                {date.toLocaleDateString("en-GB", {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                })}
              </span>
              <span className="hidden xl:inline">{date.getDate()}</span>
            </p>
            <p className="hidden text-[13px] leading-[1.45] xl:mt-3 xl:block">
              <span className="block text-ink-2">
                {date.toLocaleDateString("en-GB", { weekday: "long" })}
              </span>
              <span className="block text-ink-3">
                {date.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}
              </span>
            </p>
          </>
        ) : (
          <Skeleton className="h-5 w-40 xl:h-10 xl:w-14" />
        )}
        {lastSync ? (
          <p className="text-[12px] text-ink-3 xl:mt-6 xl:border-t xl:border-rule-2 xl:pt-3">
            Monitoring checked{" "}
            <span className="telemetry text-ink-2">{relativeTime(lastSync)}</span>
          </p>
        ) : null}
      </div>

      <div className="min-w-0">
        <div className="flex flex-col-reverse gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 max-w-[46rem]">
            {isLoading || now == null ? (
              <div className="space-y-3">
                <Skeleton className="h-8 w-[min(26rem,90%)]" />
                <Skeleton className="h-4 w-[min(34rem,95%)]" />
              </div>
            ) : (
              <>
                <p className="text-[24px] font-medium leading-[1.2] tracking-[-0.02em] text-ink-1 sm:text-[30px]">
                  <Headline facts={facts} />
                </p>
                <p className="mt-2.5 max-w-[64ch] text-[14.5px] leading-[1.55] text-ink-2">
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
                ? "border border-rule-1 bg-paper text-ink-1 hover:bg-wash"
                : "bg-signal text-paper hover:bg-[color-mix(in_oklab,var(--ww-signal)_88%,black)]"
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

        <dl className="mt-7 grid grid-cols-2 border-t border-rule-2 sm:grid-cols-5">
          <Reading label="Active shipments" value={facts.active} isLoading={isLoading} />
          <Reading label="Under way on AIS" value={facts.underway} isLoading={isLoading} live />
          <Reading label="Arriving within 72h" value={facts.arriving72h} isLoading={isLoading} />
          <Reading label="ETA revised, 24h" value={facts.etaRevised24h} isLoading={isLoading} />
          <Reading
            label="Missing documents"
            value={facts.missingDocs}
            isLoading={isLoading}
            className="max-sm:hidden"
          />
        </dl>
      </div>
    </header>
  );
}

function Headline({ facts }: { facts: MastheadFacts }) {
  if (facts.exceptions > 0) {
    return (
      <>
        <span className="font-semibold tabular-nums text-alert">{facts.exceptions}</span>{" "}
        {facts.exceptions === 1 ? "shipment needs" : "shipments need"} a decision.
      </>
    );
  }
  if (facts.toReview > 0) {
    return (
      <>
        Nothing at risk. <span className="tabular-nums">{facts.toReview}</span> to review.
      </>
    );
  }
  return <>Every shipment is on schedule.</>;
}

function summary(facts: MastheadFacts, now: number) {
  const parts: string[] = [];
  if (facts.overdueDepartures > 0) {
    parts.push(
      `${facts.overdueDepartures} departure${facts.overdueDepartures === 1 ? " is" : "s are"} overdue`,
    );
  }
  if (facts.nextArrival?.eta) {
    parts.push(
      `Next arrival is ${facts.nextArrival.client_name} into ${facts.nextArrival.destination} on ${shortDate(facts.nextArrival.eta, now)}`,
    );
  }
  parts.push(
    facts.underway > 0
      ? `${facts.underway} vessel${facts.underway === 1 ? " is" : "s are"} reporting under way`
      : "No vessel is reporting under way right now",
  );
  return `${parts.join(". ")}.`;
}

/** A standing reading. Neutral by design: a count is not a verdict, so
 * nothing here is coloured except the live marker when vessels are moving. */
function Reading({
  label,
  value,
  isLoading,
  live = false,
  className = "",
}: {
  label: string;
  value: number;
  isLoading: boolean;
  live?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col-reverse gap-1.5 border-rule-2 py-3.5 pr-5 [&:not(:first-child)]:sm:border-l [&:not(:first-child)]:sm:pl-5 ${className}`}
    >
      <dt className="flex items-center gap-1.5 text-[12px] text-ink-3">
        {live && value > 0 ? <Mark filled tone="signal" size={5} /> : null}
        {label}
      </dt>
      <dd
        className={`text-[22px] font-medium leading-none tracking-[-0.02em] tabular-nums ${
          value === 0 ? "text-ink-3" : "text-ink-1"
        }`}
      >
        {isLoading ? <Skeleton className="h-5 w-7" /> : value}
      </dd>
    </div>
  );
}
