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
  move: "text-sea-move",
  quiet: "text-muted-foreground",
};

/**
 * The page's readings as one instrument strip: a single panel divided into
 * cells, each a label and a condensed figure. Colour only when the reading
 * means something.
 */
export function Readouts({ items, loading = false }: { items: ReadoutItem[]; loading?: boolean }) {
  return (
    <dl className="panel grid grid-cols-2 overflow-hidden sm:grid-cols-[repeat(auto-fit,minmax(150px,1fr))]">
      {items.map((item, i) => (
        <div
          key={item.label}
          className={`border-sea-rule-2 px-4 py-3.5 sm:px-5 ${i > 0 ? "sm:border-l" : ""} ${
            i % 2 === 1 ? "max-sm:border-l" : ""
          } ${i > 1 ? "max-sm:border-t" : ""}`}
        >
          <dt className="flex items-center gap-1.5 text-[12px] font-medium text-sea-ink-3">
            {item.mark}
            {item.label}
          </dt>
          <dd
            className={`figure mt-1 text-[30px] leading-[32px] ${
              item.tone ? TONE[item.tone] : "text-sea-ink"
            }`}
          >
            {loading ? (
              <span className="inline-block h-7 w-10 animate-pulse rounded-sm bg-sea-paper-2" />
            ) : (
              item.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
