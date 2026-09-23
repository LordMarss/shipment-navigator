import { Link, useNavigate } from "@tanstack/react-router";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronRight, Search, X } from "lucide-react";

import { useShipmentFilters, type SortKey } from "@/components/useShipmentFilters";
import {
  ACTIVE_STATUSES,
  formatCost,
  formatEta,
  shortId,
  type Alert,
  type Shipment,
  type ShipmentDocument,
  type ShipmentStatus,
  type VesselPosition,
} from "@/lib/api";
import { deriveVesselCondition } from "@/lib/aisAutomation";
import {
  alertSeverity,
  docsFor,
  drift,
  shipmentHealth,
  type Health,
  type Severity,
} from "@/lib/lifecycle";
import { useMonitoringConfig } from "@/hooks/useMonitoringConfig";
import { useMinWidth } from "@/components/maritime/useNow";
import {
  AisTarget,
  ConditionMark,
  ManifestMeter,
  Skeleton,
  TCount,
} from "@/components/maritime/marks";
import {
  ago,
  formatCoordinates,
  shortDate,
  targetOf,
  voyageOf,
  conditionOf,
  type ConditionLevel,
  type Target,
  type Voyage,
} from "@/components/maritime/format";

const DAY = 86_400_000;
const noop = () => {};
const SEVERITY_RANK: Record<Severity, number> = { critical: 0, attention: 1, informational: 2 };
/** On phones each group shows its first entries and offers the rest. */
const COMPACT_LIMIT = 8;

export type Lens = "all" | "attention" | "underway" | "arriving" | "changed";
const LENSES: { key: Lens; label: string }[] = [
  { key: "all", label: "All" },
  { key: "attention", label: "Intervention" },
  { key: "underway", label: "Under way" },
  { key: "arriving", label: "Arriving 72h" },
];
export const LENS_LABEL: Record<Lens, string> = {
  all: "All voyages",
  attention: "Needs intervention",
  underway: "Under way on AIS",
  arriving: "Arriving within 72 hours",
  changed: "ETA revised in the last 24 hours",
};

const PHASE_WORD: Record<ShipmentStatus, string> = {
  Scheduled: "Scheduled",
  Booked: "Booked",
  Departed: "Departed",
  "In Transit": "In transit",
  "Approaching Destination": "Approaching",
  Arrived: "Arrived",
  "At Port": "At port",
  "Cleared Customs": "Cleared",
  Delivered: "Delivered",
};

type GroupKey = "intervention" | "sea" | "port" | "arrived";
const GROUPS: { key: GroupKey; label: string; order: string }[] = [
  { key: "intervention", label: "Needs intervention", order: "most urgent first" },
  { key: "sea", label: "At sea", order: "by ETA" },
  { key: "port", label: "Awaiting departure", order: "by ETD" },
  { key: "arrived", label: "Arrived", order: "latest first" },
];
const AT_SEA = new Set<ShipmentStatus>(["Departed", "In Transit", "Approaching Destination"]);

type Row = {
  s: Shipment;
  health: Health;
  condition: ConditionLevel | null;
  docs: { attached: number; total: number };
  alerts: { count: number; severity: Severity } | undefined;
  position: VesselPosition | null;
  target: Target;
  voyage: Voyage;
  /** ETA slip against the original plan, in hours, when it matters. */
  slip: number | null;
  group: GroupKey;
};

const field =
  "focus-ring h-8 w-full rounded-[2px] border border-sea-rule bg-sea-surface px-2.5 text-[13px] text-sea-ink transition-colors placeholder:text-sea-ink-3 hover:border-sea-ink-4";

const time = (iso: string | null | undefined, fallback: number) =>
  iso ? new Date(iso).getTime() : fallback;

/**
 * The passage board: every shipment as a passage from port to port, set as
 * an operations board rather than a list. Rows are grouped by what they
 * need from the operator (intervention, at sea, awaiting departure,
 * arrived) and each group is ordered by the date that matters to it. The
 * route is the widest column and its track is aligned across rows, so the
 * fleet's progress reads down the page like a movement board. Sorting by a
 * column flattens the groups; one click restores them.
 */
export function VoyageBoard({
  shipments,
  documents,
  alerts,
  positions,
  isLoading,
  now,
  focusId = null,
  onFocus = noop,
  lens: controlledLens,
  onLensChange,
  showLenses = true,
  changedIds,
  title = "Passage board",
  showLandedCost = false,
  emptyTitle = "No voyages on the board",
  emptyDescription = "Create a shipment and its passage will be plotted here.",
  emptyAction,
}: {
  shipments: Shipment[];
  documents: ShipmentDocument[];
  alerts: Alert[];
  positions: Map<string, VesselPosition> | undefined;
  isLoading: boolean;
  now: number | null;
  focusId?: string | null;
  onFocus?: (id: string | null) => void;
  /** Controlled lens (the dashboard drives it from its situation bar). */
  lens?: Lens;
  onLensChange?: (lens: Lens) => void;
  /** The board's own lens tabs; off where the page supplies its own control. */
  showLenses?: boolean;
  /** Shipments whose ETA was revised recently, for the "changed" lens. */
  changedIds?: Set<string>;
  title?: string;
  showLandedCost?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: ReactNode;
}) {
  const [ownLens, setOwnLens] = useState<Lens>("all");
  const lens = controlledLens ?? ownLens;
  const setLens = onLensChange ?? setOwnLens;
  const navigate = useNavigate();
  const config = useMonitoringConfig();
  const { query, setQuery, status, setStatus, client, setClient, clients, sort, toggleSort, rows } =
    useShipmentFilters(shipments);
  const [grouped, setGrouped] = useState(true);
  const [openArrived, setOpenArrived] = useState(false);
  const [expanded, setExpanded] = useState<Set<GroupKey>>(new Set());
  const searchRef = useRef<HTMLInputElement | null>(null);
  // Columns that only fit on wider screens are added, not CSS-hidden: a
  // hidden <col> in a fixed-layout table still takes a share of the width.
  const lg = useMinWidth(1024);
  const xl = useMinWidth(1280);
  const xxl = useMinWidth(1536);
  const cols = { docs: xl, cost: showLandedCost && lg, upd: xxl };

  // "/" jumps to the board's search, as in most operations tools.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (e.key !== "/" || e.metaKey || e.ctrlKey) return;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      )
        return;
      e.preventDefault();
      searchRef.current?.focus();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const alertsByShipment = useMemo(() => {
    const map = new Map<string, { severity: Severity; count: number }>();
    for (const a of alerts) {
      if (!a.shipment_id) continue;
      const severity = alertSeverity(a);
      const existing = map.get(a.shipment_id);
      if (!existing) map.set(a.shipment_id, { severity, count: 1 });
      else {
        existing.count += 1;
        if (SEVERITY_RANK[severity] < SEVERITY_RANK[existing.severity])
          existing.severity = severity;
      }
    }
    return map;
  }, [alerts]);

  const enriched = useMemo<Row[]>(
    () =>
      rows.map((s) => {
        const docs = docsFor(documents, s.id);
        const health = shipmentHealth(s, docs, config);
        const condition = conditionOf(health.level);
        const position = s.vessel_mmsi ? (positions?.get(s.vessel_mmsi) ?? null) : null;
        const kind = positions && s.vessel_mmsi ? deriveVesselCondition(s, position).kind : null;
        const voyage = voyageOf(s, now);
        const d = drift(s.planned_eta ?? s.previous_eta, s.eta);
        const slip = d && Math.abs(d.hours) >= config.eta_attention_hours ? d.hours : null;
        const group: GroupKey = condition
          ? "intervention"
          : voyage.arrived
            ? "arrived"
            : s.actual_departure || AT_SEA.has(s.status)
              ? "sea"
              : "port";
        return {
          s,
          health,
          condition,
          docs,
          alerts: alertsByShipment.get(s.id),
          position,
          target: targetOf(position, kind, Boolean(s.vessel_mmsi), now),
          voyage,
          slip,
          group,
        };
      }),
    [rows, documents, config, positions, alertsByShipment, now],
  );

  const matches = (r: Row, l: Lens) => {
    if (l === "attention") return r.condition != null;
    if (l === "underway") return r.target.state === "active";
    if (l === "changed") return changedIds?.has(r.s.id) ?? false;
    if (l === "arriving") {
      if (r.voyage.arrived || !r.s.eta || now == null) return false;
      const t = new Date(r.s.eta).getTime();
      return t > now && t <= now + 3 * DAY;
    }
    return true;
  };
  const counts = Object.fromEntries(
    LENSES.map((l) => [l.key, enriched.filter((r) => matches(r, l.key)).length]),
  ) as Record<Lens, number>;
  const visible = enriched.filter((r) => matches(r, lens));
  const searching = query.trim() !== "" || status !== "all" || client !== "all";
  const filtered = lens !== "all" || searching;
  const clearAll = () => {
    setLens("all");
    setQuery("");
    setStatus("all");
    setClient("all");
  };

  const sections = useMemo(() => {
    if (!grouped) return [{ key: null, rows: visible }] as const;
    const far = Number.MAX_SAFE_INTEGER;
    const by: Record<GroupKey, (a: Row, b: Row) => number> = {
      intervention: (a, b) =>
        (a.condition === "alarm" ? 0 : 1) - (b.condition === "alarm" ? 0 : 1) ||
        time(a.s.eta, far) - time(b.s.eta, far),
      sea: (a, b) => time(a.s.eta, far) - time(b.s.eta, far),
      port: (a, b) => time(a.s.planned_etd, far) - time(b.s.planned_etd, far),
      arrived: (a, b) =>
        time(b.s.actual_arrival ?? b.s.eta, 0) - time(a.s.actual_arrival ?? a.s.eta, 0),
    };
    return GROUPS.map((g) => ({
      key: g.key,
      rows: visible.filter((r) => r.group === g.key).sort(by[g.key]),
    })).filter((g) => g.rows.length > 0);
  }, [grouped, visible]);

  const onSort = (key: SortKey) => {
    setGrouped(false);
    toggleSort(key);
  };
  const groupMeta = (key: GroupKey) => GROUPS.find((g) => g.key === key)!;
  const isCollapsed = (key: GroupKey | null) => key === "arrived" && !openArrived && !searching;
  const toggleExpanded = (key: GroupKey) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const colCount = 5 + Number(cols.docs) + Number(cols.cost) + Number(cols.upd);

  return (
    <section
      id="board"
      aria-labelledby="board-title"
      className="min-w-0 scroll-mt-[calc(var(--rail-h)+12px)]"
    >
      {/* Title, lenses and tools */}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 pb-3">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-5 gap-y-2">
          <h2 id="board-title" className="chart-label !text-[11.5px] text-sea-ink">
            {title}
          </h2>
          {showLenses ? (
            <div role="group" aria-label="Show" className="flex max-w-full gap-4 overflow-x-auto">
              {LENSES.map((l) => {
                const on = lens === l.key;
                return (
                  <button
                    key={l.key}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setLens(l.key)}
                    className={`focus-ring shrink-0 whitespace-nowrap border-b-2 pb-0.5 text-[12.5px] transition-colors ${
                      on
                        ? "border-sea-ink text-sea-ink"
                        : "border-transparent text-sea-ink-3 hover:text-sea-ink"
                    }`}
                  >
                    {l.label}
                    <span className="telemetry ml-1.5 text-[10.5px] text-sea-ink-3">
                      {isLoading ? "" : counts[l.key]}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : lens !== "all" ? (
            <span className="inline-flex items-center gap-2 text-[12.5px] text-sea-ink">
              {LENS_LABEL[lens]}
              <span className="telemetry text-[10.5px] text-sea-ink-3">{visible.length}</span>
              <button
                type="button"
                onClick={() => setLens("all")}
                className="focus-ring inline-flex items-center gap-1 text-sea-ink-3 hover:text-sea-ink"
                aria-label="Show all voyages"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </span>
          ) : (
            <span className="telemetry text-[10.5px] text-sea-ink-3">
              {isLoading ? "" : `${shipments.length} voyages`}
            </span>
          )}
        </div>

        <div className="grid w-full grid-cols-2 gap-1.5 sm:flex sm:w-auto sm:items-center">
          <label className="relative col-span-2 block sm:w-56">
            <span className="sr-only">Search shipments</span>
            <Search
              aria-hidden
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-sea-ink-3"
            />
            <input
              ref={searchRef}
              className={`${field} pl-8 pr-7`}
              placeholder="Client, port, vessel, MMSI"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <kbd className="telemetry pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 text-[10px] text-sea-ink-4 sm:block">
              /
            </kbd>
          </label>
          <select
            className={`${field} sm:w-auto`}
            aria-label="Filter by phase"
            value={status}
            onChange={(e) => setStatus(e.target.value as ShipmentStatus | "all")}
          >
            <option value="all">Any phase</option>
            {ACTIVE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select
            className={`${field} sm:w-auto sm:max-w-[11rem]`}
            aria-label="Filter by client"
            value={client}
            onChange={(e) => setClient(e.target.value)}
          >
            <option value="all">Any client</option>
            {clients.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          {!grouped ? (
            <button
              type="button"
              onClick={() => setGrouped(true)}
              className="focus-ring col-span-2 h-8 whitespace-nowrap rounded-[2px] border border-sea-rule px-2.5 text-[12.5px] text-sea-ink hover:bg-sea-paper-2 sm:col-span-1"
            >
              Group by state
            </button>
          ) : null}
        </div>
      </div>

      {/* Wide: the board */}
      <div className="hidden border-t border-sea-ink md:block">
        <table className="w-full table-fixed border-collapse text-left">
          <colgroup>
            <col className="w-[26px]" />
            <col className="w-[22%] xl:w-[19%]" />
            <col />
            <col className="w-[96px] xl:w-[104px]" />
            <col className="w-[24%] xl:w-[23%]" />
            {cols.docs ? <col className="w-[72px]" /> : null}
            {cols.cost ? <col className="w-[92px]" /> : null}
            {cols.upd ? <col className="w-[44px]" /> : null}
          </colgroup>
          <thead
            className={`sticky top-[var(--rail-h)] z-[5] bg-sea-paper ${!isLoading && shipments.length === 0 ? "hidden" : ""}`}
          >
            <tr className="shadow-[inset_0_-1px_0_var(--sea-rule)]">
              <th scope="col" className="py-2">
                <span className="sr-only">Condition level</span>
              </th>
              <Th sortKey="client_name" sort={grouped ? undefined : sort} onSort={onSort}>
                Shipment
              </Th>
              <Th sortKey="status" sort={grouped ? undefined : sort} onSort={onSort}>
                <span className="grid w-full grid-cols-[minmax(0,1fr)_minmax(72px,2fr)_minmax(0,1fr)] gap-3">
                  <span className="text-right">Origin</span>
                  <span className="text-center">Passage</span>
                  <span>Destination</span>
                </span>
              </Th>
              <Th sortKey="eta" sort={grouped ? undefined : sort} onSort={onSort}>
                ETA
              </Th>
              <Th>Condition</Th>
              {cols.docs ? <Th>Docs</Th> : null}
              {cols.cost ? (
                <Th sortKey="landed_cost" sort={grouped ? undefined : sort} onSort={onSort}>
                  Landed
                </Th>
              ) : null}
              {cols.upd ? <Th>Upd</Th> : null}
            </tr>
          </thead>
          <tbody>
            {isLoading
              ? Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i} className="border-b border-sea-rule-2 bg-sea-surface">
                    <td />
                    <td className="py-3 pr-4">
                      <Skeleton className="h-3.5 w-3/4" />
                      <Skeleton className="mt-2 h-2.5 w-1/3" />
                    </td>
                    <td className="py-3 pr-6">
                      <Skeleton className="mt-1 h-[2px] w-full" />
                      <Skeleton className="mt-3 h-2.5 w-1/2" />
                    </td>
                    <td className="py-3 pr-3">
                      <Skeleton className="h-3.5 w-12" />
                    </td>
                    <td />
                    {cols.docs ? <td /> : null}
                    {cols.cost ? <td /> : null}
                    {cols.upd ? <td /> : null}
                  </tr>
                ))
              : sections.map((section) => (
                  <Fragment key={section.key ?? "flat"}>
                    {section.key ? (
                      <GroupHead
                        colSpan={colCount}
                        label={groupMeta(section.key).label}
                        order={groupMeta(section.key).order}
                        count={section.rows.length}
                        tone={section.key === "intervention" ? "alarm" : undefined}
                        collapsible={section.key === "arrived" && !searching}
                        collapsed={isCollapsed(section.key)}
                        onToggle={() => setOpenArrived((v) => !v)}
                      />
                    ) : null}
                    {isCollapsed(section.key)
                      ? null
                      : section.rows.map((r) => (
                          <BoardRow
                            key={r.s.id}
                            row={r}
                            now={now}
                            cursor={focusId === r.s.id}
                            onFocus={onFocus}
                            cols={cols}
                            onOpen={() =>
                              navigate({ to: "/shipments/$id", params: { id: r.s.id } })
                            }
                          />
                        ))}
                  </Fragment>
                ))}
          </tbody>
        </table>
      </div>

      {/* Narrow: each voyage as a compact strip, still grouped */}
      <div className="border-t border-sea-ink md:hidden">
        {isLoading
          ? Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="space-y-2.5 border-b border-sea-rule-2 bg-sea-surface px-3 py-4"
              >
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-[2px] w-full" />
              </div>
            ))
          : sections.map((section) => {
              const collapsed = isCollapsed(section.key);
              const all = section.key != null && expanded.has(section.key);
              const shown = collapsed
                ? []
                : all
                  ? section.rows
                  : section.rows.slice(0, COMPACT_LIMIT);
              return (
                <div key={section.key ?? "flat"}>
                  {section.key ? (
                    <CompactGroupHead
                      label={groupMeta(section.key).label}
                      count={section.rows.length}
                      tone={section.key === "intervention" ? "alarm" : undefined}
                      collapsible={section.key === "arrived" && !searching}
                      collapsed={collapsed}
                      onToggle={() => setOpenArrived((v) => !v)}
                    />
                  ) : null}
                  <ul>
                    {shown.map((r) => (
                      <CompactRow key={r.s.id} row={r} now={now} />
                    ))}
                  </ul>
                  {!collapsed && section.key && section.rows.length > COMPACT_LIMIT && !all ? (
                    <button
                      type="button"
                      onClick={() => toggleExpanded(section.key!)}
                      className="focus-ring flex h-11 w-full items-center justify-center border-b border-sea-rule-2 bg-sea-surface text-[13px] font-medium text-sea-ink"
                    >
                      Show {section.rows.length - COMPACT_LIMIT} more
                    </button>
                  ) : null}
                </div>
              );
            })}
      </div>

      {!isLoading && visible.length === 0 ? (
        <div className="border-b border-sea-rule-2 bg-sea-surface px-4 py-10">
          {shipments.length === 0 ? (
            <>
              <p className="text-[14px] font-medium text-sea-ink">{emptyTitle}</p>
              <p className="mt-1 max-w-[52ch] text-[13px] text-sea-ink-2">{emptyDescription}</p>
              {emptyAction ? <div className="mt-4">{emptyAction}</div> : null}
            </>
          ) : (
            <>
              <p className="text-[14px] font-medium text-sea-ink">
                {lens === "attention" && !searching
                  ? "Nothing needs intervention"
                  : "Nothing matches this view"}
              </p>
              <p className="mt-1 text-[13px] text-sea-ink-2">
                {lens === "attention" && !searching
                  ? "Every voyage is on schedule with its documents in order."
                  : filtered
                    ? "Widen the search or filters to see more voyages."
                    : "No voyages to show."}
              </p>
              {filtered ? (
                <button
                  type="button"
                  onClick={clearAll}
                  className="focus-ring mt-3 text-[13px] font-medium text-sea-ink underline decoration-sea-ink-4 underline-offset-2 hover:decoration-sea-ink"
                >
                  Clear search and filters
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {!isLoading && visible.length > 0 ? (
        <p className="mt-3 max-w-[90ch] text-[12px] leading-[1.5] text-sea-ink-3">
          Vessel plotted by schedule and phase. Blue track: under way on AIS. Hollow target: AIS
          fix, not moving. Struck target: AIS lost.{" "}
          <Link
            to="/map"
            className="text-sea-ink underline decoration-sea-ink-4 underline-offset-2"
          >
            Fleet map
          </Link>
        </p>
      ) : null}
    </section>
  );
}

/* ---------------------------------------------------------------- rows --- */

function GroupHead({
  colSpan,
  label,
  order,
  count,
  tone,
  collapsible,
  collapsed,
  onToggle,
}: {
  colSpan: number;
  label: string;
  order: string;
  count: number;
  tone?: "alarm" | undefined;
  collapsible: boolean;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const inner = (
    <span className="flex items-baseline gap-2.5">
      {collapsible ? (
        <ChevronRight
          aria-hidden
          className={`size-3.5 translate-y-[2px] text-sea-ink-3 transition-transform duration-150 ${collapsed ? "" : "rotate-90"}`}
        />
      ) : null}
      <span className={`chart-label ${tone === "alarm" ? "text-sea-red" : "text-sea-ink"}`}>
        {label}
      </span>
      <span className="telemetry text-[10.5px] text-sea-ink-2">{count}</span>
      <span className="text-[11.5px] text-sea-ink-3">{collapsed ? "shown on request" : order}</span>
    </span>
  );
  return (
    <tr className="border-b border-sea-rule">
      <th
        scope="colgroup"
        colSpan={colSpan}
        className="bg-sea-paper px-0 pb-2 pt-5 text-left font-normal [tr:first-child>&]:pt-3"
      >
        {collapsible ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={!collapsed}
            className="focus-ring -ml-0.5 pl-0.5"
          >
            {inner}
          </button>
        ) : (
          <span className="pl-[26px]">{inner}</span>
        )}
      </th>
    </tr>
  );
}

function CompactGroupHead({
  label,
  count,
  tone,
  collapsible,
  collapsed,
  onToggle,
}: {
  label: string;
  count: number;
  tone?: "alarm" | undefined;
  collapsible: boolean;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const inner = (
    <>
      <span className={`chart-label ${tone === "alarm" ? "text-sea-red" : "text-sea-ink"}`}>
        {label}
      </span>
      <span className="telemetry text-[10.5px] text-sea-ink-2">{count}</span>
      {collapsible ? (
        <ChevronRight
          aria-hidden
          className={`ml-auto size-4 text-sea-ink-3 transition-transform duration-150 ${collapsed ? "" : "rotate-90"}`}
        />
      ) : null}
    </>
  );
  return collapsible ? (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      className="focus-ring flex h-11 w-full items-center gap-2.5 border-b border-sea-rule text-left"
    >
      {inner}
    </button>
  ) : (
    <h3 className="flex items-baseline gap-2.5 border-b border-sea-rule pb-2 pt-5">{inner}</h3>
  );
}

function BoardRow({
  row,
  now,
  cursor,
  onFocus,
  onOpen,
  cols,
}: {
  row: Row;
  now: number | null;
  cursor: boolean;
  onFocus: (id: string | null) => void;
  onOpen: () => void;
  cols: { docs: boolean; cost: boolean; upd: boolean };
}) {
  const { s, health, condition, docs, alerts, position, target, voyage, slip } = row;

  return (
    <tr
      onClick={onOpen}
      onMouseEnter={() => onFocus(s.id)}
      onMouseLeave={() => onFocus(null)}
      className={`group relative cursor-pointer border-b border-sea-rule-2 align-top transition-colors duration-100 ${
        cursor ? "bg-sea-shallows" : "bg-sea-surface hover:bg-sea-shallows/70"
      }`}
    >
      <td className="relative pt-[15px]">
        <span
          aria-hidden
          className={`absolute inset-y-0 left-0 w-[2px] ${cursor ? "bg-sea-ink" : "bg-transparent group-hover:bg-sea-ink-4"}`}
        />
        <span className="flex justify-center">
          {condition ? <ConditionMark level={condition} /> : null}
        </span>
      </td>

      <td className="py-2.5 pr-4">
        <Link
          to="/shipments/$id"
          params={{ id: s.id }}
          onClick={(e) => e.stopPropagation()}
          onFocus={() => onFocus(s.id)}
          onBlur={() => onFocus(null)}
          title={s.client_name}
          className="focus-ring block truncate text-[13.5px] font-medium leading-[20px] text-sea-ink"
        >
          {s.client_name}
        </Link>
        <span className="telemetry mt-0.5 block truncate text-[10.5px] leading-[16px] text-sea-ink-3">
          {shortId(s.id)}
          {s.reference ? <span className="ml-2 text-sea-ink-4">{s.reference}</span> : null}
        </span>
      </td>

      <td className="py-2.5 pr-5">
        <Passage
          s={s}
          voyage={voyage}
          target={target}
          position={position}
          now={now}
          cursor={cursor}
        />
      </td>

      <td className="py-2.5 pr-3">
        {s.eta ? (
          <>
            <span
              className="block text-[14px] font-medium leading-[20px] tabular-nums text-sea-ink"
              title={formatEta(s.eta)}
            >
              {shortDate(s.eta, now)}
            </span>
            <span className="mt-0.5 flex items-baseline gap-2 leading-[16px]">
              {voyage.arrived ? (
                <span className="chart-label !text-[10px] text-sea-green">Arrived</span>
              ) : (
                <TCount iso={s.eta} now={now} />
              )}
              {slip != null && !voyage.arrived ? <Slip hours={slip} /> : null}
            </span>
          </>
        ) : (
          <span className="text-[12.5px] leading-[20px] text-sea-ink-3">No ETA</span>
        )}
      </td>

      <td className="py-2.5 pr-4">
        {condition ? (
          <span title={`${health.level}: ${health.reason}`} className="block min-w-0">
            <span className="flex min-w-0 items-baseline gap-2 leading-[20px]">
              <span
                className={`chart-label shrink-0 !text-[10px] ${condition === "alarm" ? "text-sea-red" : "text-sea-amber-ink"}`}
              >
                {health.level}
              </span>
              <span className="truncate text-[12.5px] text-sea-ink">{health.reason}</span>
            </span>
            <span className="mt-0.5 block truncate text-[12px] leading-[16px] text-sea-ink-3">
              {health.action ?? "Review the voyage"}
              {alerts ? (
                <span className="telemetry ml-2 text-[10px] text-sea-ink-3">
                  {alerts.count} alert{alerts.count === 1 ? "" : "s"}
                </span>
              ) : null}
            </span>
          </span>
        ) : null}
      </td>

      {cols.docs ? (
        <td className="py-2.5 pr-3 pt-[15px]">
          <ManifestMeter attached={docs.attached} total={docs.total} />
        </td>
      ) : null}

      {cols.cost ? (
        <td className="py-2.5 pr-3">
          <span className="telemetry text-[11.5px] leading-[20px] text-sea-ink-2">
            {s.landed_cost != null ? formatCost(s.landed_cost) : "Not set"}
          </span>
        </td>
      ) : null}

      {cols.upd ? (
        <td className="py-2.5 pr-3">
          {now != null ? (
            <span
              className="telemetry text-[10.5px] leading-[20px] text-sea-ink-3"
              title={`Updated ${new Date(s.updated_at).toLocaleString()}`}
            >
              {ago(s.updated_at, now)}
            </span>
          ) : null}
        </td>
      ) : null}
    </tr>
  );
}

/** ETA slip against the original plan: amber for a revision to review,
 * red once it is large enough to put the voyage at risk. */
function Slip({ hours }: { hours: number }) {
  const config = useMonitoringConfig();
  const late = hours > 0;
  const tone =
    late && hours >= config.eta_risk_hours
      ? "text-sea-red"
      : late
        ? "text-sea-amber-ink"
        : "text-sea-ink-3";
  return (
    <span
      className={`telemetry text-[10.5px] font-medium ${tone}`}
      title={`Current ETA is ${Math.abs(hours)} hours ${late ? "later" : "earlier"} than the original ETA`}
    >
      {late ? "+" : "−"}
      {Math.abs(hours)}h
    </span>
  );
}

/**
 * Port to port, aligned across rows. The track is drawn between the two
 * port names: made good solid (blue only when AIS confirms the vessel is
 * under way), planned dotted, the vessel as its AIS target. Under the
 * track, the vessel and its reading on the left and the passage state on
 * the right.
 */
function Passage({
  s,
  voyage,
  target,
  position,
  now,
  cursor,
}: {
  s: Shipment;
  voyage: Voyage;
  target: Target;
  position: VesselPosition | null;
  now: number | null;
  cursor: boolean;
}) {
  const departureOverdue =
    !s.actual_departure &&
    s.planned_etd != null &&
    now != null &&
    new Date(s.planned_etd).getTime() < now;
  const readingTone =
    target.state === "active"
      ? "text-sea-move"
      : target.stopped
        ? "text-sea-amber-ink"
        : "text-sea-ink-3";
  const fix =
    position && target.state !== "none"
      ? `Last fix ${target.age} ago at ${formatCoordinates(position.latitude, position.longitude)}${
          target.cog != null ? `, COG ${String(Math.round(target.cog)).padStart(3, "0")}°` : ""
        }`
      : undefined;

  return (
    <div>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(72px,2fr)_minmax(0,1fr)] items-center gap-3 leading-[20px]">
        <span className="truncate text-right text-[12.5px] text-sea-ink-2" title={s.origin}>
          {s.origin}
        </span>
        <Track s={s} voyage={voyage} target={target} cursor={cursor} overdue={departureOverdue} />
        <span
          className={`truncate text-[12.5px] ${voyage.arrived ? "text-sea-ink-2" : "font-medium text-sea-ink"}`}
          title={s.destination}
        >
          {s.destination}
        </span>
      </div>
      <div className="mt-0.5 flex items-baseline justify-between gap-3 leading-[16px]">
        <span className="flex min-w-0 items-baseline gap-2 text-[11.5px]" title={fix}>
          <span className="truncate text-sea-ink-2">{s.vessel_name ?? "No vessel assigned"}</span>
          {s.vessel_name && !voyage.arrived ? (
            <FreshReading
              value={target.reading}
              className={`telemetry shrink-0 text-[10.5px] ${readingTone}`}
            />
          ) : null}
        </span>
        <span className="flex shrink-0 items-baseline gap-2">
          {!s.actual_departure && !voyage.arrived ? (
            <span
              className={`telemetry text-[10.5px] ${departureOverdue ? "font-medium text-sea-red" : "text-sea-ink-3"}`}
            >
              {s.planned_etd ? `ETD ${shortDate(s.planned_etd, now)}` : "No ETD"}
            </span>
          ) : null}
          <span className="chart-label !text-[9.5px] text-sea-ink-3">{PHASE_WORD[s.status]}</span>
          {voyage.day ? (
            <span className="telemetry text-[10.5px] text-sea-ink-3">
              D{voyage.day.elapsed}/{voyage.day.total}
            </span>
          ) : null}
        </span>
      </div>
    </div>
  );
}

/** A reading that briefly tints when its value changes after first render,
 * so a vessel that starts or stops moving is noticed on refresh. */
function FreshReading({ value, className }: { value: string; className: string }) {
  const prev = useRef(value);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (prev.current !== value) {
      // Data arriving for the first time is not a change worth flagging.
      const wasReading = !/^No (AIS|MMSI)$/.test(prev.current);
      prev.current = value;
      if (wasReading) setTick((t) => t + 1);
    }
  }, [value]);
  return (
    <span key={tick} className={`${className} ${tick > 0 ? "fresh" : ""}`}>
      {value}
    </span>
  );
}

function Track({
  s,
  voyage,
  target,
  cursor,
  overdue,
}: {
  s: Shipment;
  voyage: Voyage;
  target: Target;
  cursor: boolean;
  overdue: boolean;
}) {
  const pos = voyage.pos;
  const moving = target.state === "active";
  const label = voyage.arrived
    ? `Arrived at ${s.destination}`
    : pos == null
      ? `Alongside at ${s.origin}, not yet sailed${overdue ? ", departure overdue" : ""}`
      : `From ${s.origin} to ${s.destination}, about ${Math.round(pos * 100)}% by schedule${moving ? ", under way" : ""}`;
  return (
    <div role="img" aria-label={label} title={label} className="relative mx-[5px] h-[14px]">
      {/* scale ticks at quarter passage, like the divisions on a chart scale */}
      {[0.25, 0.5, 0.75].map((t) => (
        <span
          key={t}
          aria-hidden
          className="absolute top-[9px] h-[3px] w-px bg-sea-rule"
          style={{ left: `${t * 100}%` }}
        />
      ))}
      {/* planned track */}
      <span
        aria-hidden
        className={`absolute inset-x-0 top-1/2 -translate-y-1/2 border-t ${
          voyage.arrived ? "border-solid border-sea-ink-4" : "border-dotted border-sea-ink-4"
        }`}
      />
      {/* track made good */}
      {pos != null && pos > 0 && !voyage.arrived ? (
        <span
          aria-hidden
          className={`absolute left-0 top-1/2 h-[2px] -translate-y-1/2 transition-[width] duration-500 ${
            moving ? "bg-sea-move" : cursor ? "bg-sea-ink" : "bg-sea-ink-2"
          }`}
          style={{ width: `${pos * 100}%` }}
        />
      ) : null}
      {/* ports */}
      <span
        aria-hidden
        className={`absolute left-0 top-1/2 size-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] ${
          overdue
            ? "border-sea-red bg-sea-red"
            : pos == null && !voyage.arrived
              ? "border-sea-ink bg-sea-ink"
              : "border-sea-ink-2 bg-sea-surface"
        }`}
      />
      <span
        aria-hidden
        className={`absolute left-full top-1/2 size-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] ${
          voyage.arrived ? "border-sea-green bg-sea-green" : "border-sea-ink bg-sea-surface"
        }`}
      />
      {/* vessel */}
      {!voyage.arrived && pos != null ? (
        <span
          aria-hidden
          className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 transition-[left] duration-500"
          style={{ left: `${pos * 100}%` }}
        >
          {target.state === "none" ? (
            <span
              className={`block size-[6px] rotate-45 ${cursor ? "bg-sea-ink" : "bg-sea-ink-2"}`}
            />
          ) : (
            <AisTarget state={target.state} stopped={target.stopped} />
          )}
        </span>
      ) : null}
    </div>
  );
}

function CompactRow({ row, now }: { row: Row; now: number | null }) {
  const { s, health, condition, target, voyage, slip } = row;
  const readingTone =
    target.state === "active"
      ? "text-sea-move"
      : target.stopped
        ? "text-sea-amber-ink"
        : "text-sea-ink-3";
  const overdue =
    !s.actual_departure &&
    s.planned_etd != null &&
    now != null &&
    new Date(s.planned_etd).getTime() < now;
  return (
    <li className="border-b border-sea-rule-2 bg-sea-surface">
      <Link
        to="/shipments/$id"
        params={{ id: s.id }}
        className="focus-ring block px-3 py-3 active:bg-sea-shallows"
      >
        <span className="flex items-baseline justify-between gap-4">
          <span className="flex min-w-0 items-center gap-2">
            {condition ? <ConditionMark level={condition} size={8} /> : null}
            <span className="truncate text-[15px] font-medium text-sea-ink">{s.client_name}</span>
          </span>
          <span className="shrink-0 text-[15px] font-medium tabular-nums text-sea-ink">
            {s.eta ? (
              shortDate(s.eta, now)
            ) : (
              <span className="font-normal text-sea-ink-3">No ETA</span>
            )}
          </span>
        </span>
        <span className="mt-0.5 flex items-baseline justify-between gap-4">
          <span className="flex min-w-0 items-baseline gap-2 text-[12px]">
            <span className="truncate text-sea-ink-2">{s.vessel_name ?? "No vessel"}</span>
            {s.vessel_name && !voyage.arrived ? (
              <span className={`telemetry shrink-0 text-[10.5px] ${readingTone}`}>
                {target.reading}
              </span>
            ) : null}
          </span>
          <span className="flex shrink-0 items-baseline gap-2">
            {s.eta && !voyage.arrived ? <TCount iso={s.eta} now={now} /> : null}
            {slip != null && !voyage.arrived ? <Slip hours={slip} /> : null}
            {voyage.arrived ? (
              <span className="chart-label !text-[10px] text-sea-green">Arrived</span>
            ) : null}
          </span>
        </span>
        <span className="mt-2.5 grid grid-cols-[minmax(0,1fr)_minmax(64px,1.6fr)_minmax(0,1fr)] items-center gap-2.5">
          <span className="truncate text-right text-[12px] text-sea-ink-2">{s.origin}</span>
          <Track s={s} voyage={voyage} target={target} cursor={false} overdue={overdue} />
          <span className="truncate text-[12px] font-medium text-sea-ink">{s.destination}</span>
        </span>
        {condition ? (
          <span className="mt-2 block text-[12.5px] leading-[1.4]">
            <span
              className={`chart-label mr-2 !text-[10px] ${condition === "alarm" ? "text-sea-red" : "text-sea-amber-ink"}`}
            >
              {health.level}
            </span>
            <span className="text-sea-ink">{health.reason}</span>
          </span>
        ) : null}
      </Link>
    </li>
  );
}

function Th({
  children,
  sortKey,
  sort,
  onSort,
  className = "",
}: {
  children: ReactNode;
  sortKey?: SortKey;
  sort?: { key: SortKey; dir: "asc" | "desc" } | undefined;
  onSort?: (key: SortKey) => void;
  className?: string;
}) {
  const active = sortKey != null && sort?.key === sortKey;
  const inner = (
    <span className="chart-label inline-flex w-full items-center gap-1">
      {children}
      {active ? (
        sort!.dir === "asc" ? (
          <ArrowUp className="size-3 shrink-0" aria-hidden />
        ) : (
          <ArrowDown className="size-3 shrink-0" aria-hidden />
        )
      ) : null}
    </span>
  );
  return (
    <th
      scope="col"
      aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : undefined}
      className={`whitespace-nowrap py-2 pr-3 font-normal text-sea-ink-3 ${className}`}
    >
      {sortKey && onSort ? (
        <button
          type="button"
          onClick={() => onSort(sortKey)}
          title="Sort by this column"
          className={`focus-ring w-full text-left transition-colors hover:text-sea-ink ${active ? "text-sea-ink" : ""}`}
        >
          {inner}
        </button>
      ) : (
        inner
      )}
    </th>
  );
}
