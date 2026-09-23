import { Link } from "@tanstack/react-router";

import { shortId, type Shipment } from "@/lib/api";
import type { Health, HealthLevel } from "@/lib/lifecycle";
import { ChartPanel, ConditionMark, Skeleton } from "@/components/maritime/marks";
import { conditionOf } from "@/components/maritime/format";

export type ConditionItem = { shipment: Shipment; health: Health; alertCount: number };

const RANK: Record<HealthLevel, number> = {
  "At Risk": 0,
  Delayed: 1,
  Attention: 2,
  "On Track": 3,
  Delivered: 4,
};
const MAX_ROWS = 6;

/**
 * Standing conditions, in the bridge's alert vocabulary: alarms (immediate
 * problems) first, then cautions. Each entry says which voyage, what the
 * condition is and the next action; the mark is the only colour.
 */
export function Conditions({
  items,
  isLoading,
  focusId,
  onFocus,
  onShowAll,
}: {
  items: ConditionItem[];
  isLoading: boolean;
  focusId: string | null;
  onFocus: (id: string | null) => void;
  onShowAll: () => void;
}) {
  const sorted = [...items].sort((a, b) => RANK[a.health.level] - RANK[b.health.level]);
  const shown = sorted.slice(0, MAX_ROWS);
  const alarms = items.filter((i) => conditionOf(i.health.level) === "alarm").length;

  return (
    <ChartPanel
      id="conditions"
      title="Conditions"
      meta={
        isLoading
          ? null
          : items.length === 0
            ? "clear"
            : `${alarms} alarm · ${items.length - alarms} caution`
      }
    >
      {isLoading ? (
        <div>
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="space-y-2 border-b border-sea-rule-2 py-3.5">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3.5 w-full" />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="border-b border-sea-rule-2 py-4 text-[13px] text-sea-ink-2">
          No alarms or cautions. Every voyage is on schedule with its documents in order.
        </p>
      ) : (
        <ol>
          {shown.map(({ shipment, health, alertCount }) => {
            const level = conditionOf(health.level)!;
            const cursor = focusId === shipment.id;
            return (
              <li key={shipment.id} className="border-b border-sea-rule-2">
                <Link
                  to="/shipments/$id"
                  params={{ id: shipment.id }}
                  onMouseEnter={() => onFocus(shipment.id)}
                  onMouseLeave={() => onFocus(null)}
                  onFocus={() => onFocus(shipment.id)}
                  onBlur={() => onFocus(null)}
                  className={`group relative grid grid-cols-[14px_minmax(0,1fr)] gap-x-3 py-3 pl-1 pr-1 transition-colors duration-100 focus-visible:outline-none ${
                    cursor ? "bg-sea-shallows" : "hover:bg-sea-shallows/60"
                  } focus-visible:bg-sea-shallows`}
                >
                  {cursor ? (
                    <span
                      aria-hidden
                      className="absolute inset-y-0 -left-px w-[2px] bg-sea-cursor"
                    />
                  ) : null}
                  <span className="flex justify-center pt-[5px]">
                    <ConditionMark level={level} />
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="truncate text-[13.5px] font-medium text-sea-ink">
                        {shipment.client_name}
                      </span>
                      <span
                        className={`chart-label shrink-0 !text-[10px] ${level === "alarm" ? "text-sea-red" : "text-sea-amber-ink"}`}
                      >
                        {health.level}
                      </span>
                    </span>
                    <span className="mt-1 block text-[13px] leading-[1.45] text-sea-ink">
                      {health.reason}
                    </span>
                    <span className="mt-1 block text-[12px] leading-[1.45] text-sea-ink-2">
                      <span aria-hidden className="text-sea-ink-4">
                        →{" "}
                      </span>
                      {health.action ?? "Review the voyage"}
                    </span>
                    <span className="telemetry mt-1.5 block text-[10.5px] text-sea-ink-3">
                      {shortId(shipment.id)}
                      {alertCount > 0 ? `  ${alertCount} alert${alertCount === 1 ? "" : "s"}` : ""}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
      {items.length > MAX_ROWS ? (
        <button
          type="button"
          onClick={onShowAll}
          className="focus-ring mt-2.5 rounded-[1px] text-[12.5px] font-medium text-sea-move hover:underline"
        >
          Show all {items.length} on the board
        </button>
      ) : null}
    </ChartPanel>
  );
}
