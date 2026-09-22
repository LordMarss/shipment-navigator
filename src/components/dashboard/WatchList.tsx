import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";

import { shortId, type Shipment } from "@/lib/api";
import type { Health, HealthLevel } from "@/lib/lifecycle";
import { Mark, Skeleton } from "@/components/dashboard/glyphs";

export type WatchItem = { shipment: Shipment; health: Health; alertCount: number };

const RANK: Record<HealthLevel, number> = {
  "At Risk": 0,
  Delayed: 1,
  Attention: 2,
  "On Track": 3,
  Delivered: 4,
};
const MAX_ROWS = 6;

const GRID =
  "lg:grid-cols-[92px_minmax(0,0.95fr)_minmax(0,1.5fr)_minmax(0,1.15fr)_16px] lg:gap-x-7";

/**
 * The attention queue: shipments that need a person, ordered by severity.
 * Severity is carried by one thing, the rail at the row's edge (red for an
 * immediate problem, amber for one to review); everything else is set in
 * neutral type so the reason and the next action are what the eye reads.
 */
export function WatchList({
  items,
  isLoading,
  focusId,
  onFocus,
  onShowAll,
}: {
  items: WatchItem[];
  isLoading: boolean;
  focusId: string | null;
  onFocus: (id: string | null) => void;
  onShowAll: () => void;
}) {
  const sorted = [...items].sort((a, b) => RANK[a.health.level] - RANK[b.health.level]);
  const shown = sorted.slice(0, MAX_ROWS);

  if (isLoading) {
    return (
      <div className="border-t border-rule-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="grid gap-2 border-b border-rule-2 py-4 lg:grid-cols-[92px_1fr_1.5fr]"
          >
            <Skeleton className="h-3 w-14" />
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-full" />
          </div>
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <p className="flex items-center gap-3 border-y border-rule-2 py-4 text-[14px] text-ink-2">
        <Mark filled tone="quiet" size={6} />
        Queue clear. Every active shipment is on schedule with its documents in order.
      </p>
    );
  }

  return (
    <>
      <div
        aria-hidden
        className={`hidden border-b border-rule-2 pb-2 pl-4 text-[11.5px] text-ink-3 lg:grid ${GRID}`}
      >
        <span>Verdict</span>
        <span>Shipment</span>
        <span>Condition</span>
        <span>Next action</span>
        <span />
      </div>
      <ol className="max-lg:border-t max-lg:border-rule-2">
        {shown.map(({ shipment, health, alertCount }) => {
          const immediate = health.level !== "Attention";
          const focused = focusId === shipment.id;
          return (
            <li key={shipment.id} className="border-b border-rule-2">
              <Link
                to="/shipments/$id"
                params={{ id: shipment.id }}
                onMouseEnter={() => onFocus(shipment.id)}
                onMouseLeave={() => onFocus(null)}
                onFocus={() => onFocus(shipment.id)}
                onBlur={() => onFocus(null)}
                className={`group relative grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-1 py-3.5 pl-4 pr-1 transition-colors duration-100 focus-visible:outline-none lg:items-baseline ${GRID} ${
                  focused ? "bg-signal-wash" : "hover:bg-wash"
                } focus-visible:bg-signal-wash`}
              >
                <span
                  aria-hidden
                  className={`absolute inset-y-0 left-0 w-[3px] ${immediate ? "bg-alert" : "bg-caution"}`}
                />
                <span className="order-2 text-[12.5px] font-medium text-ink-1 lg:order-none">
                  {health.level}
                  <span className="sr-only">
                    {immediate ? ", immediate problem" : ", to review"}
                  </span>
                </span>
                <span className="order-1 min-w-0 lg:order-none">
                  <span className="block truncate text-[14px] font-medium text-ink-1">
                    {shipment.client_name}
                  </span>
                  <span className="mt-0.5 flex items-baseline gap-2.5 text-[11.5px] text-ink-3">
                    <span className="telemetry">{shortId(shipment.id)}</span>
                    {alertCount > 0 ? (
                      <span>
                        {alertCount} alert{alertCount === 1 ? "" : "s"}
                      </span>
                    ) : null}
                  </span>
                </span>
                <span className="order-3 col-span-2 text-[13.5px] leading-[1.45] text-ink-1 lg:order-none lg:col-span-1">
                  {health.reason}
                </span>
                <span className="order-4 col-span-2 text-[13px] leading-[1.45] text-ink-2 lg:order-none lg:col-span-1">
                  {health.action ?? "Review the shipment"}
                </span>
                <ArrowRight
                  aria-hidden
                  className="hidden size-3.5 self-center text-ink-4 transition-colors group-hover:text-signal lg:block"
                />
              </Link>
            </li>
          );
        })}
      </ol>
      {items.length > MAX_ROWS ? (
        <button
          type="button"
          onClick={onShowAll}
          className="focus-ring mt-3 rounded-[2px] text-[13px] font-medium text-signal hover:underline"
        >
          Show all {items.length} in the fleet below
        </button>
      ) : null}
    </>
  );
}
