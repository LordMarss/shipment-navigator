import { Link } from "@tanstack/react-router";
import { ArrowRight, Check } from "lucide-react";
import { useMemo } from "react";

import type { Shipment, ShipmentDocument, VesselPosition } from "@/lib/api";
import { shortId } from "@/lib/api";
import { deriveVesselCondition } from "@/lib/aisAutomation";
import { docsFor, drift, shipmentHealth, type Health } from "@/lib/lifecycle";
import { useMonitoringConfig } from "@/hooks/useMonitoringConfig";
import {
  conditionOf,
  slipLabel,
  targetOf,
  voyageOf,
  type ConditionLevel,
} from "@/components/maritime/format";
import { ConditionMark, Skeleton } from "@/components/maritime/marks";

const HOUR = 3_600_000;
/** Rows shown before the rest are handed to the board. */
const LIMIT = 6;

type Tab = "documents" | "timeline" | undefined;

type Item = {
  s: Shipment;
  health: Health;
  level: ConditionLevel;
  /** The one machine reading that states the problem: "ETD +7D". */
  reading: { label: string; value: string } | null;
  /** Where on the record the operator should land. */
  tab: Tab;
};

/**
 * The first thing on the dashboard: every voyage that needs a decision,
 * alarms before cautions, each row stating what is wrong, the reading that
 * proves it, and the next step. The whole row opens the record.
 */
export function AttentionQueue({
  shipments,
  documents,
  positions,
  now,
  isLoading,
  onFocus,
  onShowAll,
}: {
  shipments: Shipment[];
  documents: ShipmentDocument[];
  positions: Map<string, VesselPosition> | undefined;
  now: number | null;
  isLoading: boolean;
  onFocus: (id: string | null) => void;
  onShowAll: () => void;
}) {
  const config = useMonitoringConfig();

  const items = useMemo<Item[]>(() => {
    const list: Item[] = [];
    for (const s of shipments) {
      const docs = docsFor(documents, s.id);
      const health = shipmentHealth(s, docs, config);
      const level = conditionOf(health.level);
      if (!level) continue;
      list.push({ s, health, level, ...readingFor(s, docs, positions, now, config) });
    }
    const rank = (i: Item) => (i.level === "alarm" ? 0 : 1);
    return list.sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (a.s.eta ? new Date(a.s.eta).getTime() : Infinity) -
          (b.s.eta ? new Date(b.s.eta).getTime() : Infinity),
    );
  }, [shipments, documents, positions, now, config]);

  const alarm = items.filter((i) => i.level === "alarm").length;
  const shown = items.slice(0, LIMIT);

  return (
    <section
      aria-labelledby="attention-title"
      className={`panel flex h-full min-w-0 flex-col overflow-hidden ${alarm > 0 ? "shadow-[inset_0_3px_0_var(--sea-red)]" : items.length > 0 ? "shadow-[inset_0_3px_0_var(--sea-amber)]" : ""}`}
    >
      <header className="flex min-h-[56px] flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-sea-rule px-4 pb-2.5 pt-3.5 sm:px-5">
        <div className="flex items-center gap-2.5">
          <h2 id="attention-title" className="panel-title !text-[15px]">
            Needs attention
          </h2>
          {!isLoading ? (
            <span
              className={`telemetry rounded-[4px] px-1.5 text-[11px] font-medium leading-[18px] ${
                alarm > 0
                  ? "bg-sea-red-soft text-sea-red"
                  : items.length
                    ? "bg-sea-amber-soft text-sea-amber-ink"
                    : "bg-sea-green-soft text-sea-green"
              }`}
            >
              {items.length}
            </span>
          ) : null}
        </div>
        {!isLoading && items.length > 0 ? (
          <p className="flex items-center gap-3 text-[12px] text-sea-ink-2">
            <span className="inline-flex items-center gap-1.5">
              <ConditionMark level="alarm" size={8} />
              <span className="telemetry text-[11px]">{alarm}</span> alarm
            </span>
            <span className="inline-flex items-center gap-1.5">
              <ConditionMark level="caution" size={8} />
              <span className="telemetry text-[11px]">{items.length - alarm}</span> caution
            </span>
          </p>
        ) : null}
      </header>

      <div className="flex-1">
        {isLoading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="border-b border-sea-rule-2 px-4 py-4 last:border-b-0">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="mt-2.5 h-3 w-2/3" />
            </div>
          ))
        ) : items.length === 0 ? (
          <div className="flex items-start gap-3 px-4 py-6">
            <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-sea-green text-sea-surface">
              <Check className="size-3" strokeWidth={2.5} aria-hidden />
            </span>
            <div>
              <p className="text-[14px] font-medium text-sea-ink">Nothing needs attention</p>
              <p className="mt-0.5 text-[13px] text-sea-ink-2">
                {shipments.length === 0
                  ? "Voyages that slip, lose AIS or miss documents will queue here."
                  : `All ${shipments.length} voyages are on schedule with their documents in order.`}
              </p>
            </div>
          </div>
        ) : (
          <ol>
            {shown.map((item) => (
              <QueueRow key={item.s.id} item={item} onFocus={onFocus} />
            ))}
          </ol>
        )}
      </div>

      {items.length > LIMIT ? (
        <button
          type="button"
          onClick={onShowAll}
          className="focus-ring flex h-10 items-center justify-center gap-1.5 border-t border-sea-rule bg-sea-paper/45 text-[12.5px] font-medium text-ww-blue hover:text-ww-blue-hover"
        >
          All {items.length} on the board <ArrowRight className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </section>
  );
}

function QueueRow({ item, onFocus }: { item: Item; onFocus: (id: string | null) => void }) {
  const { s, health, level, reading, tab } = item;
  const alarm = level === "alarm";
  return (
    <li className="border-b border-sea-rule-2 last:border-b-0">
      <Link
        to="/shipments/$id"
        params={{ id: s.id }}
        search={tab ? { tab } : {}}
        onMouseEnter={() => onFocus(s.id)}
        onMouseLeave={() => onFocus(null)}
        onFocus={() => onFocus(s.id)}
        onBlur={() => onFocus(null)}
        className="focus-ring group relative grid grid-cols-[12px_minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 px-4 py-3.5 transition-colors duration-150 hover:bg-sea-shallows sm:px-5 md:grid-cols-[12px_minmax(0,1fr)_minmax(0,1.35fr)_76px_92px] md:items-start md:gap-x-5"
      >
        <span className="pt-[5px]">
          <ConditionMark level={level} size={9} />
        </span>

        {/* Who and where */}
        <span className="min-w-0">
          <span className="block truncate text-[14.5px] font-medium leading-[20px] text-sea-ink">
            {s.client_name}
          </span>
          <span className="mt-1 flex min-w-0 items-center gap-2 text-[12px] leading-[18px] text-sea-ink-3">
            <span className="ref-tag shrink-0">{shortId(s.id)}</span>
            <span className="truncate">
              {s.origin} <span className="text-sea-ink-4">→</span> {s.destination}
            </span>
          </span>
        </span>

        {/* The reading, top right on phones */}
        <span className="col-start-3 row-start-1 text-right md:col-start-4">
          {reading ? (
            <>
              <span className="chart-label block !text-[9.5px] text-sea-ink-3">
                {reading.label}
              </span>
              <span className="telemetry block text-[13px] font-medium leading-[18px] text-sea-ink">
                {reading.value}
              </span>
            </>
          ) : null}
        </span>

        {/* What is wrong and what to do */}
        <span className="col-span-2 col-start-2 min-w-0 md:col-span-1 md:col-start-3 md:row-start-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span
              className={`chart-label shrink-0 !text-[10px] ${alarm ? "text-sea-red" : "text-sea-amber-ink"}`}
            >
              {health.level}
            </span>
            <span className="text-[13.5px] leading-[20px] text-sea-ink">
              {health.action ?? "Review the voyage"}
            </span>
          </span>
          <span className="mt-0.5 block truncate text-[12px] leading-[16px] text-sea-ink-3">
            {health.reason}
          </span>
        </span>

        <span className="col-span-2 col-start-2 flex items-center gap-1.5 text-[12.5px] font-medium text-sea-ink-3 transition-colors duration-150 group-hover:text-ww-blue group-focus-visible:text-ww-blue md:col-span-1 md:col-start-5 md:row-start-1 md:justify-end md:pt-0.5">
          {alarm ? "Investigate" : "Review"}
          <ArrowRight
            className="size-3.5 transition-transform duration-150 group-hover:translate-x-0.5"
            aria-hidden
          />
        </span>
      </Link>
    </li>
  );
}

/** The single reading that best evidences the problem, and the record tab
 * that holds the fix. Order follows urgency: a voyage that has not sailed,
 * then one that has not arrived, then a slipped ETA, lost AIS, documents. */
function readingFor(
  s: Shipment,
  docs: { attached: number; total: number },
  positions: Map<string, VesselPosition> | undefined,
  now: number | null,
  config: { eta_attention_hours: number },
): { reading: Item["reading"]; tab: Tab } {
  const voyage = voyageOf(s, now);
  if (now != null && !s.actual_departure && s.planned_etd) {
    const late = Math.round((now - new Date(s.planned_etd).getTime()) / HOUR);
    if (late > 0) return { reading: { label: "ETD", value: slipLabel(late) }, tab: "timeline" };
  }
  if (now != null && !voyage.arrived && s.eta) {
    const late = Math.round((now - new Date(s.eta).getTime()) / HOUR);
    if (late > 0) return { reading: { label: "ETA", value: slipLabel(late) }, tab: "timeline" };
  }
  const d = drift(s.planned_eta ?? s.previous_eta, s.eta);
  if (d && Math.abs(d.hours) >= config.eta_attention_hours)
    return { reading: { label: "ETA vs plan", value: slipLabel(d.hours) }, tab: "timeline" };
  if (s.vessel_mmsi && s.actual_departure && !voyage.arrived) {
    const position = positions?.get(s.vessel_mmsi) ?? null;
    const kind = positions ? deriveVesselCondition(s, position).kind : null;
    const target = targetOf(position, kind, true, now);
    if (target.state === "lost" && target.age)
      return {
        reading: { label: "AIS fix", value: `${target.age.toUpperCase()} AGO` },
        tab: undefined,
      };
  }
  if (docs.attached < docs.total)
    return {
      reading: { label: "Docs", value: `${docs.attached}/${docs.total}` },
      tab: "documents",
    };
  return { reading: null, tab: undefined };
}
