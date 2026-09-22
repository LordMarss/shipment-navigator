import { Plus, X } from "lucide-react";

import { Skeleton, btnPrimary } from "@/components/AppShell";
import type { Shipment } from "@/lib/api";
import { relativeTime } from "@/lib/lifecycle";

import { shortDate } from "@/components/dashboard/format";

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
 * of context, then the standing readings on a single ruled line.
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
    <header className="grid grid-cols-[minmax(0,1fr)] pb-2 pt-7 xl:grid-cols-[var(--ww-margin)_minmax(0,1fr)] xl:pt-10">
      <h1 className="sr-only">Operations</h1>

      {/* Log-page date, in the margin */}
      <div className="mb-5 flex items-baseline gap-3 xl:mb-0 xl:block xl:pr-10">
        {date ? (
          <>
            <p className="text-[15px] font-medium tabular-nums text-foreground xl:text-[56px] xl:font-normal xl:leading-[0.9] xl:tracking-[-0.04em]">
              <span className="xl:hidden">
                {date.toLocaleDateString("en-GB", {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                })}
              </span>
              <span className="hidden xl:inline">{date.getDate()}</span>
            </p>
            <p className="hidden text-sm text-foreground xl:mt-3 xl:block">
              {date.toLocaleDateString("en-GB", { weekday: "long" })}
              <span className="block text-muted-foreground">
                {date.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}
              </span>
            </p>
          </>
        ) : (
          <Skeleton className="h-5 w-40 xl:h-12 xl:w-16" />
        )}
        {lastSync ? (
          <p className="text-xs text-muted-foreground xl:mt-6">
            Monitoring checked {relativeTime(lastSync)}
          </p>
        ) : null}
      </div>

      <div className="min-w-0">
        <div className="flex flex-col-reverse gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 max-w-[46rem]">
            {isLoading || now == null ? (
              <div className="space-y-3">
                <Skeleton className="h-9 w-[min(28rem,90%)]" />
                <Skeleton className="h-4 w-[min(34rem,95%)]" />
              </div>
            ) : (
              <>
                <p className="text-[28px] font-semibold leading-[1.12] tracking-[-0.025em] text-foreground sm:text-[36px]">
                  <Headline facts={facts} />
                </p>
                <p className="mt-3 max-w-[62ch] text-[15px] leading-[1.5] text-muted-foreground">
                  {summary(facts, now)}
                </p>
              </>
            )}
          </div>
          <button
            className={`${btnPrimary} shrink-0 self-start`}
            onClick={onToggleForm}
            aria-expanded={formOpen}
          >
            {formOpen ? (
              <X className="size-3.5" aria-hidden />
            ) : (
              <Plus className="size-3.5" aria-hidden />
            )}
            {formOpen ? "Close form" : "New shipment"}
          </button>
        </div>

        <dl className="mt-8 grid grid-cols-2 border-t border-foreground/10 sm:grid-cols-5">
          <Reading label="Active shipments" value={facts.active} isLoading={isLoading} />
          <Reading
            label="Under way on AIS"
            value={facts.underway}
            isLoading={isLoading}
            tone="text-primary-deep"
          />
          <Reading label="Arriving within 72h" value={facts.arriving72h} isLoading={isLoading} />
          <Reading
            label="ETA revised, 24h"
            value={facts.etaRevised24h}
            isLoading={isLoading}
            tone="text-warning"
          />
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
        <span className="tabular-nums text-risk">{facts.exceptions}</span>{" "}
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

function Reading({
  label,
  value,
  isLoading,
  tone,
  className = "",
}: {
  label: string;
  value: number;
  isLoading: boolean;
  tone?: string;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col-reverse gap-1 border-foreground/10 py-4 pr-6 [&:not(:first-child)]:sm:border-l [&:not(:first-child)]:sm:pl-6 ${className}`}
    >
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={`text-[26px] font-semibold leading-none tracking-[-0.02em] tabular-nums ${
          value === 0 ? "text-foreground/30" : (tone ?? "text-foreground")
        }`}
      >
        {isLoading ? <Skeleton className="h-6 w-8" /> : value}
      </dd>
    </div>
  );
}
