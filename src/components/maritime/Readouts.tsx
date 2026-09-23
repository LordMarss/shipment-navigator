import type { ReactNode } from "react";

export type ReadoutItem = {
  label: string;
  value: ReactNode;
  /** Colour only when the reading means something: alarm, caution, movement. */
  tone?: "alarm" | "caution" | "move" | "quiet";
  mark?: ReactNode;
};

const TONE: Record<NonNullable<ReadoutItem["tone"]>, string> = {
  alarm: "text-risk",
  caution: "text-warning",
  move: "text-primary",
  quiet: "text-muted-foreground",
};

/**
 * A row of instrument readouts, as on the dashboard's bridge console:
 * condensed label, telemetry value, ruled cells. Built on the shared
 * tokens, so inside a page header (the console band) it takes the console
 * colours and on chart paper it takes the paper ones.
 */
export function Readouts({ items, loading = false }: { items: ReadoutItem[]; loading?: boolean }) {
  return (
    <dl className="grid grid-cols-2 border-t border-border sm:grid-cols-[repeat(auto-fit,minmax(140px,1fr))]">
      {items.map((item, i) => (
        <div
          key={item.label}
          className={`border-border px-3 py-3 first:pl-0 ${i > 0 ? "sm:border-l" : ""} ${
            i % 2 === 1 ? "max-sm:border-l" : "max-sm:pl-0"
          } ${i > 1 ? "max-sm:border-t" : ""}`}
        >
          <dt className="label-xs flex items-center gap-1.5">
            {item.mark}
            {item.label}
          </dt>
          <dd
            className={`telemetry mt-1.5 text-[20px] leading-none ${
              item.tone ? TONE[item.tone] : "text-foreground"
            }`}
          >
            {loading ? (
              <span className="inline-block h-5 w-8 animate-pulse bg-surface" />
            ) : (
              item.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
