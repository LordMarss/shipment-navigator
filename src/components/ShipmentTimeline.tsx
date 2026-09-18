import { SourceTag } from "@/components/StatusPill";
import { buildTimeline, formatDayTime } from "@/lib/lifecycle";
import type { Shipment, ShipmentEvent } from "@/lib/api";

const KIND_LABEL: Record<string, string> = {
  planned: "Planned",
  actual: "Actual",
  current: "Current",
  pending: "Pending",
};

/**
 * Planned vs current vs actual, side by side. Anything not yet recorded stays
 * pending rather than being estimated.
 */
export function ShipmentTimeline({
  shipment,
  events,
}: {
  shipment: Shipment;
  events: ShipmentEvent[];
}) {
  const timeline = buildTimeline(shipment, events);

  return (
    <section className="panel overflow-hidden">
      <header className="border-b border-border px-4 py-3">
        <h2 className="label-xs">Lifecycle timeline</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Planned, current and actual milestones as recorded on this shipment
        </p>
      </header>

      <ol className="px-4 py-3">
        {timeline.map((entry, i) => {
          const recorded = Boolean(entry.value);
          const dot = !recorded
            ? "bg-transparent border border-border"
            : entry.delayed
              ? "bg-risk"
              : entry.kind === "planned"
                ? "bg-muted-foreground/40"
                : "bg-positive";

          return (
            <li key={entry.key} className="relative flex gap-3 pb-3 last:pb-1">
              {i < timeline.length - 1 ? (
                <span aria-hidden className="absolute left-[5px] top-4 h-full w-px bg-border" />
              ) : null}
              <span aria-hidden className={`mt-1.5 size-[11px] shrink-0 rounded-full ${dot}`} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{entry.label}</span>
                  <span className="text-xs uppercase tracking-[0.05em] text-muted-foreground">
                    {KIND_LABEL[recorded ? entry.kind : "pending"]}
                  </span>
                  <span className={`ml-auto text-xs ${recorded ? "text-foreground" : "text-muted-foreground"}`}>
                    {recorded ? formatDayTime(entry.value) : "Not recorded"}
                  </span>
                </div>
                {entry.note ? (
                  <p className={`mt-0.5 text-xs ${entry.delayed ? "text-risk" : "text-muted-foreground"}`}>
                    {entry.note}
                  </p>
                ) : null}
                {entry.source ? (
                  <div className="mt-0.5">
                    <SourceTag source={entry.source} automated={Boolean(entry.automated)} />
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
