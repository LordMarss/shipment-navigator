import { SourceTag } from "@/components/StatusPill";
import { formatDayTime } from "@/lib/lifecycle";
import type { ShipmentEvent } from "@/lib/api";

const CATEGORY_LABEL: Record<string, string> = {
  status: "Status",
  health: "Health",
  eta: "Schedule",
  event: "Lifecycle",
  note: "Note",
  monitoring: "Monitoring",
};

/**
 * Audit trail of every recorded change. Values come from `shipment_events`
 * only — nothing is inferred or invented here.
 */
export function StatusHistory({ events }: { events: ShipmentEvent[] }) {
  return (
    <section className="panel overflow-hidden">
      <header className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="text-[13px] font-semibold">History &amp; audit trail</h2>
        <span className="text-[11px] text-muted-foreground">
          {events.length} record{events.length === 1 ? "" : "s"}
        </span>
      </header>

      {events.length === 0 ? (
        <p className="px-3 py-6 text-center text-[12px] text-muted-foreground">
          No recorded changes yet. Every future update is logged here with its source.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {events.map((e) => (
            <li key={e.id} className="px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-sm border border-border bg-subtle px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
                  {CATEGORY_LABEL[e.category] ?? e.category}
                </span>
                <span className="text-[13px] font-medium text-foreground">
                  {e.field ?? e.event_type}
                </span>
                <span className="ml-auto text-[11px] text-muted-foreground">
                  {formatDayTime(e.occurred_at)}
                </span>
              </div>
              {e.from_value || e.to_value ? (
                <p className="mt-1 text-[12px] text-muted-foreground">
                  <span className="line-through opacity-70">{e.from_value ?? "not set"}</span>{" "}
                  <span aria-hidden>→</span>{" "}
                  <span className="text-foreground">{e.to_value ?? "cleared"}</span>
                </p>
              ) : null}
              {e.reason ? (
                <p className="mt-1 text-[12px] text-muted-foreground">Reason: {e.reason}</p>
              ) : null}
              <div className="mt-1 flex items-center gap-2">
                <SourceTag source={e.source} automated={e.automated} />
                {e.actor ? (
                  <span className="text-[11px] text-muted-foreground">· {e.actor}</span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
