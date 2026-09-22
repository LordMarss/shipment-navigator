import { Link } from "@tanstack/react-router";
import { ArrowRight, Check } from "lucide-react";

import { Skeleton } from "@/components/AppShell";
import { shortId, type Shipment } from "@/lib/api";
import type { Health, HealthLevel } from "@/lib/lifecycle";

export type WatchItem = { shipment: Shipment; health: Health; alertCount: number };

const RANK: Record<HealthLevel, number> = {
  "At Risk": 0,
  Delayed: 1,
  Attention: 2,
  "On Track": 3,
  Delivered: 4,
};
const MAX_ROWS = 6;

/**
 * What needs a person, as a ruled watch list: the verdict, the shipment,
 * why, and the suggested next move, each in its own aligned column so the
 * eye can run straight down any one of them. Same `shipmentHealth` verdict
 * the masthead and sidebar count.
 */
export function WatchList({
  items,
  isLoading,
  focusId,
  onFocus,
  onShowAll,
}: {
  onShowAll: () => void;
  items: WatchItem[];
  isLoading: boolean;
  focusId: string | null;
  onFocus: (id: string | null) => void;
}) {
  const sorted = [...items].sort((a, b) => RANK[a.health.level] - RANK[b.health.level]);
  const shown = sorted.slice(0, MAX_ROWS);

  if (isLoading) {
    return (
      <div className="divide-y divide-foreground/8">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="grid gap-2 py-4 lg:grid-cols-[88px_1fr_1.5fr]">
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
      <p className="flex items-center gap-3 py-2 text-[15px] text-foreground">
        <Check className="size-4 text-positive" aria-hidden />
        Nothing needs a decision. Every active shipment is on schedule with its documents in order.
      </p>
    );
  }

  return (
    <>
      <div
        aria-hidden
        className="hidden border-b border-foreground/10 pb-2 text-xs text-muted-foreground lg:grid lg:grid-cols-[88px_minmax(0,1fr)_minmax(0,1.45fr)_minmax(0,1.1fr)_20px] lg:gap-x-6"
      >
        <span>Verdict</span>
        <span>Shipment</span>
        <span>Why</span>
        <span>Next move</span>
        <span />
      </div>
      <ol>
        {shown.map(({ shipment, health, alertCount }) => {
          const risk = health.level !== "Attention";
          const focused = focusId === shipment.id;
          return (
            <li key={shipment.id} className="border-b border-foreground/8 last:border-b-0">
              <Link
                to="/shipments/$id"
                params={{ id: shipment.id }}
                onMouseEnter={() => onFocus(shipment.id)}
                onMouseLeave={() => onFocus(null)}
                onFocus={() => onFocus(shipment.id)}
                onBlur={() => onFocus(null)}
                className={`group relative -mx-3 grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-1.5 px-3 py-4 transition-colors duration-150 focus-visible:outline-none lg:grid-cols-[88px_minmax(0,1fr)_minmax(0,1.45fr)_minmax(0,1.1fr)_20px] lg:items-baseline ${
                  focused ? "bg-atmosphere/70" : "hover:bg-atmosphere/50"
                } focus-visible:bg-atmosphere/70 focus-visible:shadow-[inset_2px_0_0_var(--color-primary)]`}
              >
                <span
                  className={`order-2 text-[11px] font-semibold uppercase tracking-[0.08em] lg:order-none ${
                    risk ? "text-risk" : "text-warning"
                  }`}
                >
                  {health.level}
                </span>
                <span className="order-1 min-w-0 lg:order-none">
                  <span className="block truncate text-[15px] font-medium text-foreground">
                    {shipment.client_name}
                  </span>
                  <span className="instrument mt-0.5 block text-[11px] text-muted-foreground">
                    {shortId(shipment.id)}
                    {alertCount > 0 ? (
                      <span className="ml-2.5 font-sans tracking-normal">
                        {alertCount} alert{alertCount === 1 ? "" : "s"}
                      </span>
                    ) : null}
                  </span>
                </span>
                <span className="order-3 col-span-2 text-sm leading-[1.45] text-foreground/85 lg:order-none lg:col-span-1">
                  {health.reason}
                </span>
                <span className="order-4 col-span-2 text-[13px] leading-[1.45] text-muted-foreground lg:order-none lg:col-span-1">
                  {health.action ?? "Review the shipment"}
                </span>
                <ArrowRight
                  aria-hidden
                  className="hidden size-3.5 self-center text-muted-foreground/60 transition-transform duration-200 ease-[var(--ease-premium)] group-hover:translate-x-0.5 group-hover:text-primary lg:block"
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
          className="focus-ring mt-4 rounded-[2px] text-[13px] font-medium text-primary hover:underline"
        >
          Show all {items.length} in the fleet below
        </button>
      ) : null}
    </>
  );
}
