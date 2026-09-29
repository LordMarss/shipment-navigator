import { Link, useNavigate } from "@tanstack/react-router";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  activeAutomationHold,
  alertSeverity,
  docsFor,
  drift,
  shipmentHealth,
  type Health,
  type Severity,
} from "@/lib/lifecycle";
import { useMonitoringConfig } from "@/hooks/useMonitoringConfig";
import { useElementWidth, useMinWidth } from "@/components/maritime/useNow";
import {
  AisTarget,
  Bearing,
  ConditionMark,
  ManifestMeter,
  PassageLine,
  PhaseLadder,
  Skeleton,
  TCount,
} from "@/components/maritime/marks";
import {
  formatCoordinates,
  shortDate,
  slipLabel,
  targetOf,
  utcDayTime,
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
  { key: "changed", label: "ETA revised 24h" },
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

type StateKey = "intervention" | "sea" | "port" | "arrived";
const STATES: { key: StateKey; label: string; order: string }[] = [
  { key: "intervention", label: "Needs intervention", order: "most urgent first" },
  { key: "sea", label: "At sea", order: "by ETA" },
  { key: "port", label: "Awaiting departure", order: "by ETD" },
  { key: "arrived", label: "Arrived", order: "latest first" },
];
const AT_SEA = new Set<ShipmentStatus>(["Departed", "In Transit", "Approaching Destination"]);

type GroupBy = "state" | "client" | "none";

type Row = {
  s: Shipment;
  health: Health;
  condition: ConditionLevel | null;
  docs: { attached: number; total: number };
  missingDocs: string[];
  alerts: { count: number; severity: Severity } | undefined;
  position: VesselPosition | null;
  target: Target;
  voyage: Voyage;
  /** ETA slip against the original plan, in hours, when it matters. */
  slip: number | null;
  state: StateKey;
  departureOverdue: boolean;
  arrivalOverdue: boolean;
  held: boolean;
  /** Departed and not yet arrived: the only voyages whose vessel movement is theirs. */
  sailing: boolean;
};

type Section = {
  key: string;
  label: string | null;
  order?: string | undefined;
  summary?: string | undefined;
  tone?: "alarm" | undefined;
  collapsible?: boolean | undefined;
  rows: Row[];
};

const field =
  "focus-ring h-8 w-full rounded-md border border-sea-rule bg-sea-surface px-2.5 text-[13px] text-sea-ink transition-colors placeholder:text-sea-ink-3 hover:border-ww-blue-line focus:border-ww-blue";

const time = (iso: string | null | undefined, fallback: number) =>
  iso ? new Date(iso).getTime() : fallback;

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return Boolean(
    el &&
    (el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      el.tagName === "SELECT" ||
      el.isContentEditable),
  );
};

/**
 * The passage board: every shipment as a passage from port to port, set as
 * an operations board rather than a list. Each row reads left to right as
 * the voyage does: shipment, origin, the passage itself, destination,
 * phase, ETA, and the exception if there is one. Rows are grouped by what
 * they need from the operator, or by client; sorting by a column flattens
 * the groups. The board is keyboard-driven (j/k or arrows to move, Enter
 * to open, Space to expand the voyage in place).
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
  title = "Shipment board",
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
  const [groupBy, setGroupBy] = useState<GroupBy>("state");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [openArrived, setOpenArrived] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const tableRef = useRef<HTMLTableElement | null>(null);
  // Columns that only fit on wider screens are added, not CSS-hidden: a
  // hidden <col> in a fixed-layout table still takes a share of the width.
  // The table/strip switch follows the viewport (CSS md:); the optional
  // columns follow the board's own width, which the sidebar and the page
  // layout decide, not the window.
  const md = useMinWidth(768);
  const [boardRef, boardWidth] = useElementWidth<HTMLElement>();
  const cols = {
    phase: boardWidth >= 960,
    docs: boardWidth >= 1040,
    cost: showLandedCost && boardWidth >= 1180,
  };

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
        const state: StateKey = condition
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
          missingDocs: documents
            .filter((x) => x.shipment_id === s.id && x.is_standard && !x.file_path)
            .map((x) => x.name),
          alerts: alertsByShipment.get(s.id),
          position,
          target: targetOf(position, kind, Boolean(s.vessel_mmsi), now),
          voyage,
          slip,
          state,
          departureOverdue:
            !s.actual_departure &&
            s.planned_etd != null &&
            now != null &&
            new Date(s.planned_etd).getTime() < now,
          arrivalOverdue:
            !voyage.arrived && s.eta != null && now != null && new Date(s.eta).getTime() < now,
          held: now != null && activeAutomationHold(s, now) != null,
          sailing: Boolean(s.actual_departure) && !voyage.arrived,
        };
      }),
    [rows, documents, config, positions, alertsByShipment, now],
  );

  const matches = (r: Row, l: Lens) => {
    if (l === "attention") return r.condition != null;
    if (l === "underway") return r.sailing && r.target.state === "active";
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

  const sections = useMemo<Section[]>(() => {
    const far = Number.MAX_SAFE_INTEGER;
    const byEta = (a: Row, b: Row) => time(a.s.eta, far) - time(b.s.eta, far);
    if (groupBy === "none") return [{ key: "flat", label: null, rows: visible }];
    if (groupBy === "client") {
      const names = Array.from(new Set(visible.map((r) => r.s.client_name))).sort((a, b) =>
        a.localeCompare(b),
      );
      return names.map((name) => {
        const list = visible.filter((r) => r.s.client_name === name).sort(byEta);
        const flagged = list.filter((r) => r.condition).length;
        return {
          key: `client:${name}`,
          label: name,
          summary: flagged ? `${flagged} flagged` : undefined,
          rows: list,
        };
      });
    }
    const by: Record<StateKey, (a: Row, b: Row) => number> = {
      intervention: (a, b) =>
        (a.condition === "alarm" ? 0 : 1) - (b.condition === "alarm" ? 0 : 1) || byEta(a, b),
      sea: byEta,
      port: (a, b) => time(a.s.planned_etd, far) - time(b.s.planned_etd, far),
      arrived: (a, b) =>
        time(b.s.actual_arrival ?? b.s.eta, 0) - time(a.s.actual_arrival ?? a.s.eta, 0),
    };
    return STATES.map((g) => {
      const list = visible.filter((r) => r.state === g.key).sort(by[g.key]);
      let summary: string | undefined;
      if (g.key === "intervention") {
        const alarm = list.filter((r) => r.condition === "alarm").length;
        summary = `${alarm} alarm, ${list.length - alarm} caution`;
      } else if (g.key === "sea") {
        const moving = list.filter((r) => r.sailing && r.target.state === "active").length;
        const lost = list.filter((r) => r.target.state === "lost").length;
        summary = `${moving} under way${lost ? `, ${lost} AIS lost` : ""}`;
      } else if (g.key === "port") {
        const soon =
          now == null ? 0 : list.filter((r) => time(r.s.planned_etd, far) - now <= 7 * DAY).length;
        summary = soon ? `${soon} sailing within 7 days` : undefined;
      }
      return {
        key: g.key,
        label: g.label,
        order: g.order,
        summary,
        tone: g.key === "intervention" ? ("alarm" as const) : undefined,
        collapsible: g.key === "arrived" && !searching,
        rows: list,
      };
    }).filter((g) => g.rows.length > 0);
  }, [groupBy, visible, now, searching]);

  const isCollapsed = useCallback(
    (sec: Section) => Boolean(sec.collapsible) && !openArrived,
    [openArrived],
  );
  const order = useMemo(
    () => sections.flatMap((sec) => (isCollapsed(sec) ? [] : sec.rows.map((r) => r.s.id))),
    [sections, isCollapsed],
  );

  const toggleRow = useCallback(
    (id: string) =>
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );

  // Keyboard: "/" search, j/k (or arrows once a row is selected) to move,
  // Enter to open, Space to expand, Escape to clear the selection.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (!md || order.length === 0) return;
      // Enter and Space belong to whatever button or link has focus.
      const onControl = Boolean(
        (e.target as HTMLElement | null)?.closest?.("button, a, [role=button]"),
      );
      if ((e.key === "Enter" || e.key === " ") && onControl) return;
      const i = selected ? order.indexOf(selected) : -1;
      const move = (to: number) => {
        e.preventDefault();
        const id = order[Math.max(0, Math.min(order.length - 1, to))]!;
        setSelected(id);
        onFocus(id);
        tableRef.current
          ?.querySelector(`[data-row="${id}"]`)
          ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      };
      if (e.key === "j" || (e.key === "ArrowDown" && selected)) move(i + 1);
      else if (e.key === "k" || (e.key === "ArrowUp" && selected)) move(i < 0 ? 0 : i - 1);
      else if (e.key === "Enter" && selected && order.includes(selected)) {
        e.preventDefault();
        navigate({ to: "/shipments/$id", params: { id: selected } });
      } else if (e.key === " " && selected) {
        e.preventDefault();
        toggleRow(selected);
      } else if (e.key === "Escape" && selected) {
        setSelected(null);
        onFocus(null);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [md, order, selected, navigate, onFocus, toggleRow]);

  const onSort = (key: SortKey) => {
    setGroupBy("none");
    toggleSort(key);
  };
  const sortFor = groupBy === "none" ? sort : undefined;
  // mark, shipment, passage, eta, exception, expand + the optional columns
  const colCount = 6 + Number(cols.phase) + Number(cols.docs) + Number(cols.cost);

  const lensList = LENSES.filter((l) => l.key !== "changed" || changedIds);
  const noData = !isLoading && shipments.length === 0;

  return (
    <section
      ref={boardRef}
      id="board"
      aria-labelledby="board-title"
      className="panel min-w-0 scroll-mt-[calc(var(--rail-h)+12px)]"
    >
      {/* Title and lenses, the lenses set on the header rule as tabs */}
      <div className="flex flex-wrap items-end justify-between gap-x-6 border-b border-sea-rule px-4 pt-3 sm:px-5">
        <div className="flex min-w-0 items-baseline gap-2.5 pb-3">
          <h2 id="board-title" className="panel-title">
            {title}
          </h2>
          <span className="text-[12px] text-sea-ink-3">
            {isLoading ? "" : `${shipments.length} voyage${shipments.length === 1 ? "" : "s"}`}
          </span>
        </div>
        {showLenses ? (
          <div
            role="group"
            aria-label="Show"
            className="-mb-px flex max-w-full gap-5 overflow-x-auto [scrollbar-width:none]"
          >
            {lensList.map((l) => {
              const on = lens === l.key;
              return (
                <button
                  key={l.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setLens(l.key)}
                  className={`focus-ring flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 pb-2.5 text-[13px] transition-colors duration-150 ${
                    on
                      ? "border-ww-blue font-medium text-sea-ink"
                      : "border-transparent text-sea-ink-3 hover:text-sea-ink"
                  }`}
                >
                  {l.label}
                  <span
                    className={`telemetry rounded-[4px] px-1 text-[10px] leading-[16px] ${
                      on ? "bg-ww-blue-soft text-ww-blue" : "text-sea-ink-3"
                    }`}
                  >
                    {isLoading ? "" : counts[l.key]}
                  </span>
                </button>
              );
            })}
          </div>
        ) : lens !== "all" ? (
          <span className="animate-in mb-2.5 inline-flex items-center gap-2 rounded-md bg-ww-blue-soft px-2 py-1 text-[12.5px] text-ww-blue">
            {LENS_LABEL[lens]}
            <span className="telemetry text-[10.5px]">{visible.length}</span>
            <button
              type="button"
              onClick={() => setLens("all")}
              className="focus-ring inline-flex items-center rounded-sm hover:text-ww-blue-hover"
              aria-label="Show all voyages"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </span>
        ) : null}
      </div>

      {/* Tools */}
      <div
        className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-sea-rule bg-sea-paper/55 px-4 py-2.5 sm:px-5 ${noData ? "hidden" : ""}`}
      >
        <div className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-1.5 sm:flex sm:w-auto sm:items-center">
          <label className="relative block sm:w-56">
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
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  if (query) setQuery("");
                  else e.currentTarget.blur();
                }
              }}
            />
            <kbd className="telemetry pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 text-[10px] text-sea-ink-4 sm:block">
              /
            </kbd>
          </label>
          {/* Phones: the filters wait behind one control */}
          <button
            type="button"
            onClick={() => setFiltersOpen((v) => !v)}
            aria-expanded={filtersOpen}
            className={`focus-ring flex h-8 items-center gap-1.5 rounded-md border px-3 text-[12.5px] font-medium sm:hidden ${
              filtersOpen || status !== "all" || client !== "all"
                ? "border-ww-blue-line bg-ww-blue-soft text-ww-blue"
                : "border-sea-rule bg-sea-surface text-sea-ink-2"
            }`}
          >
            Filters
            {Number(status !== "all") + Number(client !== "all") > 0 ? (
              <span className="telemetry text-[10.5px]">
                {Number(status !== "all") + Number(client !== "all")}
              </span>
            ) : null}
          </button>
          <select
            className={`${field} col-span-2 sm:w-auto ${filtersOpen ? "" : "max-sm:hidden"}`}
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
            className={`${field} col-span-2 sm:w-auto sm:max-w-[11rem] ${filtersOpen ? "" : "max-sm:hidden"}`}
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
          <div
            role="group"
            aria-label="Group rows by"
            className={`col-span-2 flex h-8 items-stretch rounded-md border border-sea-rule bg-sea-surface text-[12.5px] sm:col-span-1 ${filtersOpen ? "" : "max-sm:hidden"}`}
          >
            {(
              [
                ["state", "State"],
                ["client", "Client"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={groupBy === key}
                onClick={() => setGroupBy(key)}
                className={`focus-ring flex-1 whitespace-nowrap px-2.5 transition-colors sm:flex-none ${
                  groupBy === key
                    ? "bg-ww-blue-soft font-medium text-ww-blue shadow-[inset_0_0_0_1px_var(--ww-blue-line)]"
                    : "text-sea-ink-2 hover:bg-sea-paper-2 hover:text-sea-ink"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {filtered ? (
          <button
            type="button"
            onClick={clearAll}
            className="focus-ring hidden rounded-sm text-[12.5px] font-medium text-ww-blue hover:text-ww-blue-hover sm:block"
          >
            Clear filters
          </button>
        ) : null}
      </div>

      {/* Wide: the board */}
      <div className="hidden md:block">
        <table ref={tableRef} className="w-full table-fixed border-collapse text-left">
          <colgroup>
            <col className="w-[38px]" />
            <col className="w-[19%] xl:w-[16%]" />
            <col />
            {cols.phase ? <col className="w-[128px]" /> : null}
            <col className="w-[92px] xl:w-[100px]" />
            <col className="w-[24%] xl:w-[20%]" />
            {cols.docs ? <col className="w-[64px]" /> : null}
            {cols.cost ? <col className="w-[88px]" /> : null}
            <col className="w-[40px]" />
          </colgroup>
          <thead
            className={`sticky top-[var(--rail-h)] z-[5] bg-sea-surface/95 backdrop-blur-sm ${noData ? "hidden" : ""}`}
          >
            <tr className="shadow-[inset_0_-1px_0_var(--sea-rule)]">
              <th scope="col" className="py-2">
                <span className="sr-only">Condition level</span>
              </th>
              <Th sortKey="client_name" sort={sortFor} onSort={onSort}>
                Shipment
              </Th>
              <th scope="col" className="py-2 pr-5 align-bottom font-normal text-sea-ink-3">
                <PassageScale />
              </th>
              {cols.phase ? (
                <Th sortKey="status" sort={sortFor} onSort={onSort}>
                  Phase
                </Th>
              ) : null}
              <Th sortKey="eta" sort={sortFor} onSort={onSort}>
                ETA
              </Th>
              <Th>Exception</Th>
              {cols.docs ? <Th>Docs</Th> : null}
              {cols.cost ? (
                <Th sortKey="landed_cost" sort={sortFor} onSort={onSort}>
                  Landed
                </Th>
              ) : null}
              <th scope="col">
                <span className="sr-only">Expand</span>
              </th>
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
                      <Skeleton className="mt-1.5 h-[2px] w-full" />
                      <Skeleton className="mt-3 h-2.5 w-1/2" />
                    </td>
                    {cols.phase ? <td /> : null}
                    <td className="py-3 pr-3">
                      <Skeleton className="h-3.5 w-12" />
                    </td>
                    <td />
                    {cols.docs ? <td /> : null}
                    {cols.cost ? <td /> : null}
                    <td />
                  </tr>
                ))
              : sections.map((sec) => (
                  <Fragment key={sec.key}>
                    {sec.label ? (
                      <GroupHead
                        colSpan={colCount}
                        section={sec}
                        collapsed={isCollapsed(sec)}
                        onToggle={() => setOpenArrived((v) => !v)}
                      />
                    ) : null}
                    {isCollapsed(sec)
                      ? null
                      : sec.rows.map((r) => (
                          <BoardRow
                            key={r.s.id}
                            row={r}
                            now={now}
                            cursor={focusId === r.s.id}
                            selected={selected === r.s.id}
                            expanded={expanded.has(r.s.id)}
                            onToggle={() => toggleRow(r.s.id)}
                            onFocus={onFocus}
                            onSelect={() => setSelected(r.s.id)}
                            cols={cols}
                            colCount={colCount}
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
      <div className="px-4 md:hidden">
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
          : sections.map((sec) => {
              const collapsed = isCollapsed(sec);
              const all = expandedGroups.has(sec.key);
              const shown = collapsed ? [] : all ? sec.rows : sec.rows.slice(0, COMPACT_LIMIT);
              return (
                <div key={sec.key}>
                  {sec.label ? (
                    <CompactGroupHead
                      section={sec}
                      collapsed={collapsed}
                      onToggle={() => setOpenArrived((v) => !v)}
                    />
                  ) : null}
                  <ul>
                    {shown.map((r) => (
                      <CompactRow key={r.s.id} row={r} now={now} />
                    ))}
                  </ul>
                  {!collapsed && sec.rows.length > COMPACT_LIMIT && !all ? (
                    <button
                      type="button"
                      onClick={() => setExpandedGroups((prev) => new Set(prev).add(sec.key))}
                      className="focus-ring flex h-11 w-full items-center justify-center border-b border-sea-rule-2 bg-sea-surface text-[13px] font-medium text-sea-ink"
                    >
                      Show {sec.rows.length - COMPACT_LIMIT} more
                    </button>
                  ) : null}
                </div>
              );
            })}
      </div>

      {!isLoading && visible.length === 0 ? (
        <div className="px-4 py-12 md:px-[38px]">
          {shipments.length === 0 ? (
            <>
              <p className="text-[14px] font-medium text-sea-ink">{emptyTitle}</p>
              <p className="mt-1 max-w-[52ch] text-[13px] text-sea-ink-2">{emptyDescription}</p>
              {emptyAction ? <div className="mt-4">{emptyAction}</div> : null}
            </>
          ) : lens === "attention" && !searching ? (
            <>
              <p className="flex items-center gap-2 text-[14px] font-medium text-sea-ink">
                <span aria-hidden className="inline-block size-[7px] rounded-full bg-sea-green" />
                Nothing needs intervention
              </p>
              <p className="mt-1 text-[13px] text-sea-ink-2">
                Every voyage is on schedule with its documents in order.
              </p>
            </>
          ) : (
            <>
              <p className="text-[14px] font-medium text-sea-ink">Nothing matches this view</p>
              <p className="mt-1 text-[13px] text-sea-ink-2">
                {query.trim()
                  ? `No voyage matches “${query.trim()}” by client, port, vessel, MMSI or SHP number.`
                  : "Widen the filters to see more voyages."}
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

      {!isLoading && visible.length > 0 ? <Legend keys={md} /> : null}
    </section>
  );
}

/* --------------------------------------------------------------- chrome --- */

/** The passage column's head: origin and destination labels either side
 * of a chart scale whose divisions line up with every track below. */
function PassageScale() {
  return (
    <span className="chart-label grid grid-cols-[minmax(0,1fr)_minmax(64px,1.3fr)_minmax(0,1fr)] items-end gap-3">
      <span className="text-right">Origin</span>
      <span aria-hidden className="relative mx-[5px] block h-[14px]">
        <span className="absolute inset-x-0 bottom-0 h-px bg-sea-ink-4" />
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <span
            key={t}
            className={`absolute bottom-0 w-px bg-sea-ink-4 ${t === 0 || t === 1 ? "h-[7px]" : "h-[4px]"}`}
            style={{ left: `${t * 100}%` }}
          />
        ))}
        <span className="absolute bottom-[5px] left-1/2 -translate-x-1/2 bg-sea-paper px-1.5 leading-none">
          Passage
        </span>
      </span>
      <span>Destination</span>
    </span>
  );
}

function Legend({ keys }: { keys: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-sea-rule-2 px-4 py-2.5 text-[11px] text-sea-ink-3 sm:px-5">
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="h-[2px] w-4 bg-sea-move" /> Under way on AIS
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="h-[2px] w-4 bg-sea-ink-2" /> Track by schedule
      </span>
      <span className="inline-flex items-center gap-1.5">
        <AisTarget state="idle" size={10} /> Fix, not moving
      </span>
      <span className="inline-flex items-center gap-1.5">
        <AisTarget state="lost" size={10} /> AIS lost
      </span>
      <span className="inline-flex items-center gap-1.5">
        <PhaseLadder status="In Transit" /> Phase: port, sea, port
      </span>
      {keys ? (
        <span className="telemetry ml-auto text-[10.5px] text-sea-ink-4">
          J K select · ENTER open · SPACE expand · / search
        </span>
      ) : null}
    </div>
  );
}

function GroupHead({
  colSpan,
  section,
  collapsed,
  onToggle,
}: {
  colSpan: number;
  section: Section;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const inner = (
    <span className="flex items-baseline gap-2.5">
      {section.collapsible ? (
        <ChevronRight
          aria-hidden
          className={`size-3.5 translate-y-[2px] text-sea-ink-3 transition-transform duration-150 ${collapsed ? "" : "rotate-90"}`}
        />
      ) : null}
      {section.tone === "alarm" ? (
        <span className="self-center">
          <ConditionMark level="alarm" size={7} />
        </span>
      ) : null}
      <span className="text-[12.5px] font-semibold text-sea-ink" title={section.order}>
        {section.label}
      </span>
      <span className="telemetry text-[11px] text-sea-ink-3">{section.rows.length}</span>
      {section.summary ? (
        <span className="text-[12px] text-sea-ink-3">{section.summary}</span>
      ) : null}
      {section.collapsible && collapsed ? (
        <span className="text-[11.5px] text-sea-ink-4">shown on request</span>
      ) : null}
    </span>
  );
  return (
    <tr className="border-y border-sea-rule-2">
      <th
        scope="colgroup"
        colSpan={colSpan}
        className="bg-sea-paper/40 px-0 py-2 text-left font-normal"
      >
        {section.collapsible ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={!collapsed}
            className="focus-ring rounded-sm pl-[14px]"
          >
            {inner}
          </button>
        ) : (
          <span className="block pl-[38px]">{inner}</span>
        )}
      </th>
    </tr>
  );
}

function CompactGroupHead({
  section,
  collapsed,
  onToggle,
}: {
  section: Section;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const inner = (
    <>
      <span className="truncate text-[12.5px] font-semibold text-sea-ink">{section.label}</span>
      <span className="telemetry text-[10.5px] text-sea-ink-2">{section.rows.length}</span>
      {section.summary ? (
        <span className="truncate text-[11.5px] text-sea-ink-3">{section.summary}</span>
      ) : null}
      {section.collapsible ? (
        <ChevronRight
          aria-hidden
          className={`ml-auto size-4 shrink-0 text-sea-ink-3 transition-transform duration-150 ${collapsed ? "" : "rotate-90"}`}
        />
      ) : null}
    </>
  );
  return section.collapsible ? (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      className="focus-ring flex h-11 w-full items-center gap-2.5 border-b border-sea-rule text-left"
    >
      {inner}
    </button>
  ) : (
    <h3 className="flex min-w-0 items-baseline gap-2.5 border-b border-sea-rule pb-2 pt-5">
      {inner}
    </h3>
  );
}

/* ---------------------------------------------------------------- rows --- */

function BoardRow({
  row,
  now,
  cursor,
  selected,
  expanded,
  onToggle,
  onFocus,
  onSelect,
  onOpen,
  cols,
  colCount,
}: {
  row: Row;
  now: number | null;
  cursor: boolean;
  selected: boolean;
  expanded: boolean;
  onToggle: () => void;
  onFocus: (id: string | null) => void;
  onSelect: () => void;
  onOpen: () => void;
  cols: { docs: boolean; cost: boolean; phase: boolean };
  colCount: number;
}) {
  const { s, health, condition, docs, alerts, voyage, slip, held } = row;
  const lit = cursor || selected;

  return (
    <>
      <tr
        data-row={s.id}
        aria-selected={selected}
        onClick={onOpen}
        onMouseEnter={() => onFocus(s.id)}
        onMouseLeave={() => onFocus(null)}
        className={`group animate-in cursor-pointer align-top transition-colors duration-100 ${
          expanded ? "" : "border-b border-sea-rule-2"
        } ${lit ? "bg-sea-shallows" : "bg-sea-surface hover:bg-sea-shallows/60"}`}
      >
        <td className="relative pt-[15px]">
          <span
            aria-hidden
            className={`absolute inset-y-0 left-0 transition-[width,background-color] duration-150 ${
              selected
                ? "w-[3px] bg-sea-ink"
                : cursor
                  ? "w-[2px] bg-sea-ink-2"
                  : "w-[2px] bg-transparent group-hover:bg-sea-ink-4"
            }`}
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
            onFocus={() => {
              onFocus(s.id);
              onSelect();
            }}
            onBlur={() => onFocus(null)}
            title={s.client_name}
            className="focus-ring block truncate text-[13.5px] font-medium leading-[20px] text-sea-ink"
          >
            {s.client_name}
          </Link>
          <span className="mt-1 flex min-w-0 items-center gap-2 text-[11px] leading-[18px] text-sea-ink-3">
            <span className="ref-tag">{shortId(s.id)}</span>
            {s.reference ? (
              <span className="min-w-0 truncate text-sea-ink-4" title={s.reference}>
                {s.reference}
              </span>
            ) : null}
          </span>
        </td>

        <td className="py-2.5 pr-5">
          <Passage row={row} now={now} cursor={lit} showPhase={!cols.phase} />
        </td>

        {cols.phase ? (
          <td className="py-2.5 pr-3">
            <span className="flex items-center gap-2 leading-[20px]">
              <PhaseLadder status={s.status} />
              <span className="truncate text-[12.5px] text-sea-ink-2">{PHASE_WORD[s.status]}</span>
            </span>
            <span className="mt-0.5 block leading-[16px]">
              {held ? (
                <span className="telemetry text-[10px] uppercase text-sea-amber-ink">
                  Automation held
                </span>
              ) : voyage.day ? (
                <span className="telemetry text-[10.5px] text-sea-ink-3">
                  D{voyage.day.elapsed}/{voyage.day.total}
                </span>
              ) : null}
            </span>
          </td>
        ) : null}

        <td className="py-2.5 pr-3">
          {s.eta ? (
            <>
              <span
                className={`block text-[14.5px] font-semibold leading-[20px] tabular-nums ${
                  row.arrivalOverdue ? "text-sea-red" : "text-sea-ink"
                }`}
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
            <span className="text-[12.5px] leading-[20px] text-sea-amber-ink">ETA not set</span>
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
                <span className="truncate text-[12.5px] text-sea-ink">
                  {health.action ?? "Review the voyage"}
                </span>
              </span>
              <span className="mt-0.5 block truncate text-[11.5px] leading-[16px] text-sea-ink-3">
                {health.reason}
              </span>
            </span>
          ) : alerts ? (
            <span className="telemetry block pt-[3px] text-[10.5px] text-sea-ink-4">
              {alerts.count} ALERT{alerts.count === 1 ? "" : "S"} LOGGED
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

        <td className="pr-1 pt-[9px] text-right">
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${s.client_name} voyage`}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            className={`focus-ring inline-grid size-6 place-items-center rounded-md text-sea-ink-3 transition-[opacity,color] hover:bg-sea-paper-2 hover:text-sea-ink ${
              expanded || lit
                ? "opacity-100"
                : "opacity-0 focus:opacity-100 group-hover:opacity-100"
            }`}
          >
            <ChevronRight
              aria-hidden
              className={`size-3.5 transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
            />
          </button>
        </td>
      </tr>
      {expanded ? (
        <tr className={`border-b border-sea-rule-2 ${lit ? "bg-sea-shallows" : "bg-sea-surface"}`}>
          <td />
          <td colSpan={colCount - 1} className="pb-3 pr-4">
            <VoyageDetail row={row} now={now} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** The voyage in place: readings a watch officer checks before opening the
 * record. Everything here is already on the page; nothing is fetched. */
function VoyageDetail({ row, now }: { row: Row; now: number | null }) {
  const { s, position, target, health, condition, missingDocs, slip } = row;
  const cell = "min-w-0 border-l border-sea-rule-2 pl-3";
  return (
    <div className="animate-in grid grid-cols-2 gap-y-3 border-t border-dashed border-sea-rule pt-3 lg:grid-cols-[repeat(4,minmax(0,1fr))_minmax(0,1.4fr)]">
      <Reading label="Position" className={cell}>
        {position && target.state !== "none" ? (
          <>
            <span className="block">
              {formatCoordinates(position.latitude, position.longitude)}
            </span>
            <span className={target.state === "lost" ? "text-sea-amber-ink" : "text-sea-ink-3"}>
              FIX {target.age?.toUpperCase()} AGO{target.state === "lost" ? ", STALE" : ""}
            </span>
          </>
        ) : (
          <span className="text-sea-ink-3">
            {s.vessel_mmsi ? "NO AIS FIX YET" : "NO MMSI, NOT TRACKED"}
          </span>
        )}
      </Reading>
      <Reading label="SOG / COG" className={cell}>
        {target.sog != null && target.state !== "none" ? (
          <span className="inline-flex items-center gap-1.5">
            <span className={target.state === "active" && row.sailing ? "text-sea-move" : ""}>
              {target.sog.toFixed(1)} KN
            </span>
            <Bearing deg={target.cog} className="text-sea-ink-2" />
            {target.cog != null ? `${String(Math.round(target.cog)).padStart(3, "0")}°` : ""}
          </span>
        ) : (
          <span className="text-sea-ink-3">NO READING</span>
        )}
      </Reading>
      <Reading label="Departure" className={cell}>
        {s.actual_departure ? (
          <>
            <span className="block">
              SAILED {utcDayTime(s.actual_departure, now).toUpperCase()}
            </span>
            {s.planned_etd ? (
              <span className="text-sea-ink-3">
                PLAN {utcDayTime(s.planned_etd, now).toUpperCase()}
              </span>
            ) : null}
          </>
        ) : s.planned_etd ? (
          <span className={row.departureOverdue ? "text-sea-red" : ""}>
            ETD {utcDayTime(s.planned_etd, now).toUpperCase()}
            {row.departureOverdue ? <span className="block">OVERDUE</span> : null}
          </span>
        ) : (
          <span className="text-sea-amber-ink">ETD NOT SET</span>
        )}
      </Reading>
      <Reading label="Arrival (UTC)" className={cell}>
        {s.actual_arrival ? (
          <span>ARRIVED {utcDayTime(s.actual_arrival, now).toUpperCase()}</span>
        ) : s.eta ? (
          <>
            <span className={`block ${row.arrivalOverdue ? "text-sea-red" : ""}`}>
              ETA {utcDayTime(s.eta, now).toUpperCase()}
            </span>
            {slip != null && s.planned_eta ? (
              <span className="text-sea-ink-3">
                PLAN {utcDayTime(s.planned_eta, now).toUpperCase()}{" "}
                <span className={slip > 0 ? "text-sea-amber-ink" : ""}>{slipLabel(slip)}</span>
              </span>
            ) : null}
          </>
        ) : (
          <span className="text-sea-amber-ink">ETA NOT SET</span>
        )}
      </Reading>
      <div className={`${cell} col-span-2 flex flex-col justify-between gap-2 lg:col-span-1`}>
        <div className="min-w-0">
          <span className="chart-label block !text-[9.5px] text-sea-ink-3">
            {condition ? "Next action" : "Documents"}
          </span>
          <p className="mt-1 text-[12.5px] leading-[1.4] text-sea-ink">
            {condition
              ? (health.action ?? "Review the voyage")
              : missingDocs.length
                ? `Missing ${missingDocs.join(", ")}`
                : "All required documents attached"}
          </p>
          {condition && missingDocs.length ? (
            <p className="mt-0.5 text-[11.5px] text-sea-ink-3">Missing {missingDocs.join(", ")}</p>
          ) : null}
        </div>
        <Link
          to="/shipments/$id"
          params={{ id: s.id }}
          onClick={(e) => e.stopPropagation()}
          className="focus-ring inline-flex items-center gap-1 self-start text-[12px] font-medium text-sea-ink underline decoration-sea-ink-4 underline-offset-2 hover:decoration-sea-ink"
        >
          Open voyage record
          <ChevronRight className="size-3" aria-hidden />
        </Link>
      </div>
    </div>
  );
}

function Reading({
  label,
  children,
  className = "",
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <span className="chart-label block !text-[9.5px] text-sea-ink-3">{label}</span>
      <span className="telemetry mt-1 block text-[11px] leading-[16px] text-sea-ink">
        {children}
      </span>
    </div>
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
      {slipLabel(hours)}
    </span>
  );
}

/**
 * Port to port, aligned across rows. The track is drawn between the two
 * port names: made good solid (blue only when AIS confirms the vessel is
 * under way), planned dotted, the vessel as its AIS target. Under the
 * track, the vessel with its reading and course on the left; on the right
 * the departure when it is still ahead.
 */
function Passage({
  row,
  now,
  cursor,
  showPhase,
}: {
  row: Row;
  now: number | null;
  cursor: boolean;
  showPhase: boolean;
}) {
  const { s, voyage, target, position } = row;
  const readingTone =
    target.state === "active" && row.sailing
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
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(64px,1.3fr)_minmax(0,1fr)] items-center gap-3 leading-[20px]">
        <span className="truncate text-right text-[12.5px] text-sea-ink-2" title={s.origin}>
          {s.origin}
        </span>
        <Track row={row} cursor={cursor} />
        <span
          className={`truncate text-[12.5px] ${
            row.arrivalOverdue
              ? "font-medium text-sea-red"
              : voyage.arrived
                ? "text-sea-ink-2"
                : "font-medium text-sea-ink"
          }`}
          title={s.destination}
        >
          {s.destination}
        </span>
      </div>
      <div className="mt-0.5 flex items-baseline justify-between gap-3 leading-[16px]">
        <span className="flex min-w-0 items-center gap-1.5 text-[11.5px]" title={fix}>
          <span
            className={`truncate ${s.vessel_name ? "vessel text-[11px] text-sea-ink-2" : "text-sea-ink-4"}`}
          >
            {s.vessel_name ?? "Vessel not assigned"}
          </span>
          {s.vessel_name && !voyage.arrived ? (
            <>
              {target.state === "active" && row.sailing ? (
                <Bearing deg={target.cog} className="text-sea-move" size={9} />
              ) : null}
              <FreshReading
                value={target.reading}
                className={`telemetry shrink-0 text-[10.5px] uppercase ${readingTone}`}
              />
            </>
          ) : null}
          {!s.actual_departure && !voyage.arrived ? (
            <span
              className={`telemetry shrink-0 text-[10.5px] uppercase ${row.departureOverdue ? "font-medium text-sea-red" : "text-sea-ink-3"}`}
            >
              {s.planned_etd ? `ETD ${shortDate(s.planned_etd, now)}` : "No ETD"}
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-baseline gap-2">
          {showPhase ? (
            <>
              <span className="chart-label !text-[9.5px] text-sea-ink-3">
                {PHASE_WORD[s.status]}
              </span>
              {voyage.day ? (
                <span className="telemetry text-[10.5px] text-sea-ink-3">
                  D{voyage.day.elapsed}/{voyage.day.total}
                </span>
              ) : null}
            </>
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

function Track({ row }: { row: Row; cursor: boolean }) {
  const { s, voyage, target } = row;
  const overdue = row.departureOverdue;
  const pos = voyage.pos;
  const moving = row.sailing && target.state === "active";
  const label = voyage.arrived
    ? `Arrived at ${s.destination}`
    : pos == null
      ? `Alongside at ${s.origin}, not yet sailed${overdue ? ", departure overdue" : ""}`
      : `From ${s.origin} to ${s.destination}, about ${Math.round(pos * 100)}% by schedule${moving ? ", under way" : ""}${row.arrivalOverdue ? ", ETA passed" : ""}`;

  return (
    <div role="img" aria-label={label} title={label} className="relative">
      {/* chart-scale divisions, aligned with the column head */}
      {[0.25, 0.5, 0.75].map((t) => (
        <span
          key={t}
          aria-hidden
          className="absolute top-[9px] h-[3px] w-px bg-sea-rule"
          style={{ left: `calc(4px + ${t} * (100% - 8px))` }}
        />
      ))}
      <PassageLine
        pos={pos}
        arrived={voyage.arrived}
        moving={moving}
        target={target.state}
        stopped={target.stopped}
        departOverdue={overdue}
        arrivalOverdue={row.arrivalOverdue}
      />
    </div>
  );
}

function CompactRow({ row, now }: { row: Row; now: number | null }) {
  const { s, health, condition, target, voyage, slip } = row;
  const readingTone =
    target.state === "active" && row.sailing
      ? "text-sea-move"
      : target.stopped
        ? "text-sea-amber-ink"
        : "text-sea-ink-3";
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
          <span
            className={`shrink-0 text-[15px] font-semibold tabular-nums ${row.arrivalOverdue ? "text-sea-red" : "text-sea-ink"}`}
          >
            {s.eta ? (
              shortDate(s.eta, now)
            ) : (
              <span className="text-[13px] font-normal text-sea-amber-ink">ETA not set</span>
            )}
          </span>
        </span>
        <span className="mt-1 flex items-center justify-between gap-4">
          <span className="flex min-w-0 items-center gap-1.5 text-[12px]">
            <PhaseLadder status={s.status} className="mr-1" />
            <span
              className={`truncate ${s.vessel_name ? "vessel text-[11px] text-sea-ink-2" : "text-sea-ink-4"}`}
            >
              {s.vessel_name ?? "Vessel not assigned"}
            </span>
            {s.vessel_name && !voyage.arrived ? (
              <span className={`telemetry shrink-0 text-[10.5px] uppercase ${readingTone}`}>
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
          <Track row={row} cursor={false} />
          <span
            className={`truncate text-[12px] font-medium ${row.arrivalOverdue ? "text-sea-red" : "text-sea-ink"}`}
          >
            {s.destination}
          </span>
        </span>
        {condition ? (
          <span className="mt-2.5 block border-l-2 border-sea-rule pl-2.5 text-[12.5px] leading-[1.4]">
            <span
              className={`chart-label mr-2 !text-[10px] ${condition === "alarm" ? "text-sea-red" : "text-sea-amber-ink"}`}
            >
              {health.level}
            </span>
            <span className="text-sea-ink">{health.action ?? health.reason}</span>
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
      className={`whitespace-nowrap py-2 pr-3 align-bottom font-normal text-sea-ink-3 ${className}`}
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
