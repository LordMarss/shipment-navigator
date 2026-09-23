import { Fragment, useState } from "react";

import { SourceMark } from "@/components/maritime/marks";
import { humanField, logValue, monthName, utcClock, weekday } from "@/components/maritime/format";
import type { ShipmentEvent } from "@/lib/api";

const CATEGORY_LABEL: Record<string, string> = {
  status: "Phase",
  health: "Health",
  eta: "Schedule",
  event: "Record",
  note: "Note",
  monitoring: "Monitoring",
};

type SourceKey = "ais" | "system" | "operator";
const sourceOf = (e: ShipmentEvent): SourceKey =>
  e.source === "ais" ? "ais" : e.automated ? "system" : "operator";
const SOURCE_CODE: Record<SourceKey, string> = { ais: "AIS", system: "SYS", operator: "OPR" };
const SOURCE_LABEL: Record<SourceKey, string> = {
  ais: "AIS",
  system: "System",
  operator: "Operator",
};

/**
 * The voyage log: every recorded change, newest first, ruled off by UTC
 * day like a logbook. Each entry reads when, source, what changed and why.
 * Source is carried by shape (AIS a target, system a filled square,
 * operator a hollow square) and operator entries are also set against a
 * rule, because a manual correction is the entry most worth finding.
 * Values come from `shipment_events` only; nothing is inferred.
 */
export function StatusHistory({ events }: { events: ShipmentEvent[] }) {
  const [only, setOnly] = useState<SourceKey | "all">("all");
  const counts = events.reduce((acc, e) => ({ ...acc, [sourceOf(e)]: acc[sourceOf(e)] + 1 }), {
    ais: 0,
    system: 0,
    operator: 0,
  } as Record<SourceKey, number>);
  const shown = only === "all" ? events : events.filter((e) => sourceOf(e) === only);

  return (
    <section
      aria-labelledby="log-title"
      className="panel min-w-0 px-4 pb-3 sm:px-5 [&_li:last-child]:border-b-0"
    >
      <div className="-mx-4 flex min-h-[52px] flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-sea-rule px-4 py-2.5 sm:-mx-5 sm:px-5">
        <h2 id="log-title" className="panel-title">
          Voyage log
          <span className="telemetry ml-2 font-normal normal-case tracking-normal text-sea-ink-3">
            {events.length} entries, UTC
          </span>
        </h2>
        {events.length > 0 ? (
          <div role="group" aria-label="Show entries from" className="flex gap-4 text-[12px]">
            {(["all", "ais", "system", "operator"] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={only === k}
                onClick={() => setOnly(k)}
                className={`focus-ring inline-flex items-center gap-1.5 border-b-2 pb-0.5 transition-colors ${
                  only === k
                    ? "border-ww-blue text-sea-ink"
                    : "border-transparent text-sea-ink-3 hover:text-sea-ink"
                }`}
              >
                {k === "all" ? null : (
                  <SourceMark
                    source={k === "ais" ? "ais" : "manual"}
                    automated={k !== "operator"}
                  />
                )}
                {k === "all" ? "All" : SOURCE_LABEL[k]}
                <span className="telemetry text-[10px] text-sea-ink-3">
                  {k === "all" ? events.length : counts[k]}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {events.length === 0 ? (
        <div className="border-b border-sea-rule-2 py-6">
          <p className="text-[13px] font-medium text-sea-ink">Nothing logged yet</p>
          <p className="mt-1 max-w-[60ch] text-[12.5px] text-sea-ink-2">
            Phase changes from AIS, schedule revisions from the system and operator corrections are
            entered here as they happen, each with its source and reason.
          </p>
        </div>
      ) : (
        <ol>
          {shown.map((e, i) => {
            const t = new Date(e.occurred_at).getTime();
            const day = new Date(e.occurred_at).toISOString().slice(0, 10);
            const prev =
              i > 0 ? new Date(shown[i - 1]!.occurred_at).toISOString().slice(0, 10) : null;
            const src = sourceOf(e);
            const d = new Date(t);
            return (
              <Fragment key={e.id}>
                {day !== prev ? (
                  <li className="chart-label border-b border-sea-rule pb-1.5 pt-4 !text-[10px] text-sea-ink-3">
                    {weekday(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12))}{" "}
                    {d.getUTCDate()} {monthName(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 15))}{" "}
                    {d.getUTCFullYear()}
                  </li>
                ) : null}
                <li
                  className={`animate-in grid grid-cols-[48px_52px_minmax(0,1fr)] gap-x-3 border-b border-sea-rule-2 py-2.5 sm:grid-cols-[52px_60px_minmax(0,1.1fr)_minmax(0,1fr)] ${
                    src === "operator" ? "shadow-[inset_2px_0_0_var(--sea-ink)] pl-2" : ""
                  }`}
                >
                  <time
                    dateTime={e.occurred_at}
                    title={new Date(e.occurred_at).toLocaleString()}
                    className="telemetry pt-px text-[11px] text-sea-ink-2"
                  >
                    {utcClock(t)}
                  </time>
                  <span className="flex items-center gap-1.5 self-start pt-[3px]">
                    <SourceMark source={e.source} automated={e.automated} />
                    <span className="telemetry text-[10px] text-sea-ink-3">{SOURCE_CODE[src]}</span>
                  </span>
                  <span className="min-w-0">
                    <span className="chart-label mr-2 !text-[9.5px] text-sea-ink-3">
                      {CATEGORY_LABEL[e.category] ?? e.category}
                    </span>
                    {e.from_value || e.to_value ? (
                      <span className="text-[13px]">
                        {humanField(e.field, e.event_type) ? (
                          <span className="text-sea-ink-2">
                            {humanField(e.field, e.event_type)}{" "}
                          </span>
                        ) : null}
                        {e.from_value ? (
                          <span className="text-sea-ink-3 line-through decoration-sea-ink-4">
                            {logValue(e.from_value)}
                          </span>
                        ) : null}
                        <span aria-hidden className="mx-1 text-sea-ink-4">
                          →
                        </span>
                        <span className="font-medium text-sea-ink">
                          {e.to_value ? logValue(e.to_value) : "cleared"}
                        </span>
                      </span>
                    ) : (
                      <span className="text-[13px] text-sea-ink">
                        {humanField(e.field, e.event_type)}
                      </span>
                    )}
                  </span>
                  <span className="col-start-3 min-w-0 text-[12px] leading-[1.45] text-sea-ink-3 sm:col-start-4">
                    {e.reason
                      ? logValue(e.reason)
                      : e.actor && src === "operator"
                        ? `Entered by ${e.actor}`
                        : ""}
                    {e.reason && e.actor && src === "operator" ? (
                      <span className="text-sea-ink-4"> ({e.actor})</span>
                    ) : null}
                  </span>
                </li>
              </Fragment>
            );
          })}
        </ol>
      )}
    </section>
  );
}
