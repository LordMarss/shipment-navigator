import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Search } from "lucide-react";

import { useShipmentFilters, type SortKey } from "@/components/useShipmentFilters";
import {
  ACTIVE_STATUSES,
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
  shipmentHealth,
  type Health,
  type Severity,
} from "@/lib/lifecycle";
import { useMonitoringConfig } from "@/hooks/useMonitoringConfig";
import {
  AisTarget,
  ChartPanel,
  ConditionMark,
  ManifestMeter,
  Skeleton,
  TCount,
} from "@/components/dashboard/marks";
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
} from "@/components/dashboard/format";

const DAY = 86_400_000;
const SEVERITY_RANK: Record<Severity, number> = { critical: 0, attention: 1, informational: 2 };
/** On phones the board keeps the first dozen and offers the rest on request. */
const COMPACT_LIMIT = 12;

export type Lens = "all" | "attention" | "underway" | "arriving";
const LENSES: { key: Lens; label: string }[] = [
  { key: "all", label: "All" },
  { key: "attention", label: "Conditions" },
  { key: "underway", label: "Under way" },
  { key: "arriving", label: "Arr ≤72h" },
];

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

type Row = {
  s: Shipment;
  health: Health;
  condition: ConditionLevel | null;
  docs: { attached: number; total: number };
  alerts: { count: number; severity: Severity } | undefined;
  position: VesselPosition | null;
  target: Target;
  voyage: Voyage;
};

const field =
  "focus-ring h-7 w-full rounded-[2px] border border-sea-rule bg-sea-paper px-2 text-[12.5px] text-sea-ink transition-colors placeholder:text-sea-ink-3 hover:border-sea-ink-3";

/**
 * The voyage board: every shipment as a passage from origin to destination.
 * Track already made good is drawn solid, the planned track ahead dashed,
 * and the vessel is plotted on the line as an AIS target (position by
 * schedule and phase; target symbol by AIS state). Same search, filters and
 * sort as every other shipment list, plus lenses for the questions a watch
 * officer asks of it.
 */
export function VoyageBoard({
  shipments,
  documents,
  alerts,
  positions,
  isLoading,
  now,
  focusId,
  onFocus,
  lens,
  onLensChange: setLens,
}: {
  shipments: Shipment[];
  documents: ShipmentDocument[];
  alerts: Alert[];
  positions: Map<string, VesselPosition> | undefined;
  isLoading: boolean;
  now: number | null;
  focusId: string | null;
  onFocus: (id: string | null) => void;
  lens: Lens;
  onLensChange: (lens: Lens) => void;
}) {
  const navigate = useNavigate();
  const config = useMonitoringConfig();
  const { query, setQuery, status, setStatus, client, setClient, clients, sort, toggleSort, rows } =
    useShipmentFilters(shipments);
  const [showAllCompact, setShowAllCompact] = useState(false);

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
        const position = s.vessel_mmsi ? (positions?.get(s.vessel_mmsi) ?? null) : null;
        const kind = positions && s.vessel_mmsi ? deriveVesselCondition(s, position).kind : null;
        return {
          s,
          health,
          condition: conditionOf(health.level),
          docs,
          alerts: alertsByShipment.get(s.id),
          position,
          target: targetOf(position, kind, Boolean(s.vessel_mmsi), now),
          voyage: voyageOf(s, now),
        };
      }),
    [rows, documents, config, positions, alertsByShipment, now],
  );

  const matches = (r: Row, l: Lens) => {
    if (l === "attention") return r.condition != null;
    if (l === "underway") return r.target.state === "active";
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
  const filtered = lens !== "all" || query.trim() !== "" || status !== "all" || client !== "all";
  const clearAll = () => {
    setLens("all");
    setQuery("");
    setStatus("all");
    setClient("all");
  };

  const tools = (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
      <div role="group" aria-label="Show" className="-mx-1 flex max-w-full overflow-x-auto">
        {LENSES.map((l) => {
          const active = lens === l.key;
          return (
            <button
              key={l.key}
              type="button"
              aria-pressed={active}
              aria-label={isLoading ? l.label : `${l.label}, ${counts[l.key]}`}
              onClick={() => setLens(l.key)}
              className={`focus-ring relative shrink-0 whitespace-nowrap rounded-[1px] px-2 pb-1 pt-0.5 transition-colors ${
                active ? "text-sea-ink" : "text-sea-ink-3 hover:text-sea-ink"
              }`}
            >
              <span className="chart-label">{l.label}</span>
              <span className="telemetry ml-1.5 text-[10.5px]">
                {isLoading ? "" : counts[l.key]}
              </span>
              <span
                aria-hidden
                className={`absolute inset-x-2 -bottom-[3px] h-[2px] ${active ? "bg-sea-cursor" : "bg-transparent"}`}
              />
            </button>
          );
        })}
      </div>
      <div className="grid w-full grid-cols-2 gap-1.5 sm:flex sm:w-auto">
        <label className="relative col-span-2 block sm:w-52">
          <span className="sr-only">Search shipments</span>
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-sea-ink-3"
          />
          <input
            className={`${field} pl-7`}
            placeholder="ID, client, port, vessel, MMSI"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <select
          className={`${field} sm:w-auto`}
          aria-label="Filter by status"
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
      </div>
    </div>
  );

  return (
    <ChartPanel
      id="board"
      title="Voyage board"
      meta={
        isLoading
          ? null
          : visible.length === shipments.length
            ? `${shipments.length} voyages`
            : `${visible.length} of ${shipments.length}`
      }
      tools={tools}
    >
      {/* Wide: the board */}
      <table className="hidden w-full table-fixed border-collapse text-left md:table">
        <colgroup>
          <col className="w-[26px]" />
          <col className="w-[24%] xl:w-[21%]" />
          <col />
          <col className="w-[13%] xl:w-[10%]" />
          <col className="w-[16%] xl:w-[13%]" />
          <col className="hidden w-[9%] xl:table-column" />
          <col className="hidden w-[5%] min-[1500px]:table-column" />
        </colgroup>
        <thead
          className={`sticky top-14 z-[5] bg-sea-paper ${!isLoading && shipments.length === 0 ? "hidden" : ""}`}
        >
          <tr className="shadow-[inset_0_-1px_0_var(--sea-rule)]">
            <th scope="col" className="py-2">
              <span className="sr-only">Condition level</span>
            </th>
            <Th sortKey="client_name" sort={sort} onSort={toggleSort}>
              Shipment / vessel
            </Th>
            <Th sortKey="status" sort={sort} onSort={toggleSort}>
              Passage
            </Th>
            <Th sortKey="eta" sort={sort} onSort={toggleSort}>
              ETA
            </Th>
            <Th>Condition</Th>
            <Th className="hidden xl:table-cell">Manifest</Th>
            <Th className="hidden text-right min-[1500px]:table-cell">Upd</Th>
          </tr>
        </thead>
        <tbody>
          {isLoading
            ? Array.from({ length: 6 }).map((_, i) => (
                <tr key={i} className="border-b border-sea-rule-2">
                  <td />
                  <td className="py-4 pr-5">
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="mt-2 h-3 w-1/2" />
                  </td>
                  <td className="py-4 pr-6">
                    <Skeleton className="h-3 w-full" />
                    <Skeleton className="mt-3 h-[2px] w-full" />
                  </td>
                  <td className="py-4 pr-4">
                    <Skeleton className="h-4 w-14" />
                  </td>
                  <td className="py-4 pr-4" />
                  <td className="hidden xl:table-cell" />
                  <td className="hidden min-[1500px]:table-cell" />
                </tr>
              ))
            : visible.map((r) => (
                <BoardRow
                  key={r.s.id}
                  row={r}
                  now={now}
                  cursor={focusId === r.s.id}
                  onFocus={onFocus}
                  onOpen={() => navigate({ to: "/shipments/$id", params: { id: r.s.id } })}
                />
              ))}
        </tbody>
      </table>

      {/* Narrow: each voyage as a compact strip */}
      <ul className="md:hidden">
        {isLoading
          ? Array.from({ length: 4 }).map((_, i) => (
              <li key={i} className="space-y-2.5 border-b border-sea-rule-2 py-4">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-[2px] w-full" />
              </li>
            ))
          : (showAllCompact ? visible : visible.slice(0, COMPACT_LIMIT)).map((r) => (
              <CompactRow key={r.s.id} row={r} now={now} />
            ))}
      </ul>
      {!isLoading && !showAllCompact && visible.length > COMPACT_LIMIT ? (
        <button
          type="button"
          onClick={() => setShowAllCompact(true)}
          className="focus-ring mt-3 w-full rounded-[2px] border border-sea-rule py-2.5 text-[13px] font-medium text-sea-ink hover:bg-sea-shallows md:hidden"
        >
          Show all {visible.length} voyages
        </button>
      ) : null}

      {!isLoading && visible.length === 0 ? (
        <div className="border-b border-sea-rule-2 py-10">
          {shipments.length === 0 ? (
            <>
              <p className="text-[14px] font-medium text-sea-ink">No voyages on the board</p>
              <p className="mt-1 max-w-[52ch] text-[13px] text-sea-ink-2">
                Create a shipment with New shipment above and its passage will be plotted here.
              </p>
            </>
          ) : (
            <>
              <p className="text-[14px] font-medium text-sea-ink">Nothing matches this view</p>
              <p className="mt-1 text-[13px] text-sea-ink-2">
                {filtered
                  ? "Widen the search or filters to see more voyages."
                  : "No voyages to show."}
              </p>
              {filtered ? (
                <button
                  type="button"
                  onClick={clearAll}
                  className="focus-ring mt-3 rounded-[1px] text-[13px] font-medium text-sea-move hover:underline"
                >
                  Clear search and filters
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {!isLoading && visible.length > 0 ? (
        <p className="mt-3 text-[12px] text-sea-ink-3">
          Vessel plotted by schedule and phase; target symbol shows AIS state. Select a voyage to
          open it, or{" "}
          <Link to="/map" className="text-sea-move hover:underline">
            view the fleet map
          </Link>
          .
        </p>
      ) : null}
    </ChartPanel>
  );
}

function BoardRow({
  row,
  now,
  cursor,
  onFocus,
  onOpen,
}: {
  row: Row;
  now: number | null;
  cursor: boolean;
  onFocus: (id: string | null) => void;
  onOpen: () => void;
}) {
  const { s, health, condition, docs, alerts, position, target, voyage } = row;
  const readingTone =
    target.state === "active"
      ? "text-sea-move"
      : target.stopped
        ? "text-sea-amber-ink"
        : "text-sea-ink-3";

  return (
    <tr
      onClick={onOpen}
      onMouseEnter={() => onFocus(s.id)}
      onMouseLeave={() => onFocus(null)}
      className={`group cursor-pointer border-b border-sea-rule-2 align-top transition-colors duration-100 ${
        cursor ? "bg-sea-shallows" : "hover:bg-sea-shallows/60"
      }`}
    >
      <td className="relative pt-[19px]">
        {cursor ? (
          <span aria-hidden className="absolute inset-y-0 left-0 w-[2px] bg-sea-cursor" />
        ) : null}
        <span className="flex justify-center">
          {condition ? <ConditionMark level={condition} /> : null}
        </span>
      </td>

      <td className="py-3.5 pr-5">
        <Link
          to="/shipments/$id"
          params={{ id: s.id }}
          onClick={(e) => e.stopPropagation()}
          onFocus={() => onFocus(s.id)}
          onBlur={() => onFocus(null)}
          className="focus-ring block truncate rounded-[1px] text-[14px] font-medium text-sea-ink"
        >
          {s.client_name}
        </Link>
        <span className="telemetry mt-0.5 block text-[11px] text-sea-ink-3">{shortId(s.id)}</span>
        <span
          className="mt-1 flex min-w-0 items-baseline gap-2 text-[12px]"
          title={
            position && target.state !== "none"
              ? `Last fix ${target.age} ago at ${formatCoordinates(position.latitude, position.longitude)}${
                  target.cog != null ? `, COG ${Math.round(target.cog)}°` : ""
                }`
              : undefined
          }
        >
          <span className="truncate text-sea-ink-2">{s.vessel_name ?? "No vessel"}</span>
          {s.vessel_name ? (
            <span className={`telemetry shrink-0 text-[11px] ${readingTone}`}>
              {target.reading}
            </span>
          ) : null}
        </span>
      </td>

      <td className="py-3.5 pr-7">
        <PassageLine s={s} voyage={voyage} target={target} now={now} cursor={cursor} />
      </td>

      <td className="py-3.5 pr-4">
        {s.eta ? (
          <>
            <span
              className="block text-[15px] font-medium tabular-nums text-sea-ink"
              title={formatEta(s.eta)}
            >
              {shortDate(s.eta, now)}
            </span>
            <span className="mt-0.5 block">
              {voyage.arrived ? (
                <span className="chart-label text-sea-green">Arrived</span>
              ) : (
                <TCount iso={s.eta} now={now} />
              )}
            </span>
          </>
        ) : (
          <span className="text-[13px] text-sea-ink-3">No ETA</span>
        )}
      </td>

      <td className="py-3.5 pr-4">
        {condition ? (
          <span
            className={`chart-label block !text-[11px] ${condition === "alarm" ? "text-sea-red" : "text-sea-amber-ink"}`}
            title={health.reason}
          >
            {condition === "alarm" ? "Alarm" : "Caution"}
          </span>
        ) : (
          <span className="chart-label block !text-[11px] text-sea-ink-4">Normal</span>
        )}
        {condition ? (
          <span className="mt-0.5 block text-[12.5px] text-sea-ink">{health.level}</span>
        ) : null}
        {alerts ? (
          <span className="mt-0.5 block text-[11.5px] text-sea-ink-3">
            {alerts.count} alert{alerts.count === 1 ? "" : "s"}
          </span>
        ) : null}
      </td>

      <td className="hidden py-3.5 pr-4 pt-4 xl:table-cell">
        <ManifestMeter attached={docs.attached} total={docs.total} />
      </td>

      <td className="hidden py-3.5 pr-3 text-right min-[1500px]:table-cell">
        {now != null ? (
          <span
            className="telemetry text-[11px] text-sea-ink-3"
            title={new Date(s.updated_at).toLocaleString()}
          >
            {ago(s.updated_at, now)}
          </span>
        ) : null}
      </td>
    </tr>
  );
}

/**
 * Port to port. Origin node on the left, destination on the right, the
 * track made good solid behind the vessel and the planned track dashed
 * ahead, the vessel as an AIS target. Under the line: the departure
 * notation on the left, phase and passage day on the right.
 */
function PassageLine({
  s,
  voyage,
  target,
  now,
  cursor,
}: {
  s: Shipment;
  voyage: Voyage;
  target: Target;
  now: number | null;
  cursor: boolean;
}) {
  const pos = voyage.pos;
  const underway = pos != null && !voyage.arrived;
  const departureOverdue =
    !s.actual_departure &&
    s.planned_etd != null &&
    now != null &&
    new Date(s.planned_etd).getTime() < now;
  const departNote = s.actual_departure
    ? `Sailed ${shortDate(s.actual_departure, now)}`
    : s.planned_etd
      ? `ETD ${shortDate(s.planned_etd, now)}`
      : "No ETD";
  const label = voyage.arrived
    ? `Arrived at ${s.destination}`
    : pos == null
      ? `Alongside at ${s.origin}, not yet sailed`
      : `Under passage from ${s.origin} to ${s.destination}, about ${Math.round(pos * 100)}% by schedule`;

  return (
    <div role="img" aria-label={label} title={label}>
      <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
        <span className="min-w-0 truncate text-sea-ink-2">{s.origin}</span>
        <span
          className={`min-w-0 truncate text-right ${voyage.arrived ? "text-sea-ink" : "font-medium text-sea-ink"}`}
        >
          {s.destination}
        </span>
      </div>

      <div className="relative mx-[4px] mt-2 h-[12px]">
        {/* planned track */}
        <span className="absolute inset-x-0 top-1/2 -translate-y-1/2 border-t border-dashed border-sea-ink-4" />
        {/* track made good */}
        {pos != null && pos > 0 ? (
          <span
            className={`absolute left-0 top-1/2 h-[2px] -translate-y-1/2 ${
              voyage.arrived ? "bg-sea-ink-3" : cursor ? "bg-sea-cursor" : "bg-sea-move"
            }`}
            style={{ width: `${pos * 100}%` }}
          />
        ) : null}
        {/* ports */}
        <span className="absolute left-0 top-1/2 size-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] border-sea-ink-2 bg-sea-paper" />
        <span
          className={`absolute left-full top-1/2 size-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] ${
            voyage.arrived ? "border-sea-green bg-sea-green" : "border-sea-ink bg-sea-paper"
          }`}
        />
        {/* vessel */}
        {!voyage.arrived && (target.state !== "none" || underway) ? (
          <span
            className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${(pos ?? 0) * 100}%` }}
          >
            {target.state === "none" ? (
              <span
                className={`block size-[6px] rotate-45 ${cursor ? "bg-sea-cursor" : "bg-sea-ink-3"}`}
              />
            ) : (
              <AisTarget state={target.state} stopped={target.stopped} cursor={cursor} />
            )}
          </span>
        ) : null}
      </div>

      <div className="mt-1.5 flex items-baseline justify-between gap-3">
        <span
          className={`telemetry truncate text-[10.5px] ${departureOverdue ? "font-medium text-sea-red" : "text-sea-ink-3"}`}
        >
          {departNote}
        </span>
        <span className="flex shrink-0 items-baseline gap-2 text-[10.5px]">
          <span className="chart-label !text-[10px] text-sea-ink-2">{PHASE_WORD[s.status]}</span>
          {voyage.day ? (
            <span className="telemetry text-sea-ink-3">
              D{voyage.day.elapsed}/{voyage.day.total}
            </span>
          ) : null}
        </span>
      </div>
    </div>
  );
}

function CompactRow({ row, now }: { row: Row; now: number | null }) {
  const { s, health, condition, target, voyage } = row;
  return (
    <li className="border-b border-sea-rule-2">
      <Link
        to="/shipments/$id"
        params={{ id: s.id }}
        className="focus-ring block py-3.5 hover:bg-sea-shallows/60"
      >
        <span className="flex items-baseline justify-between gap-4">
          <span className="flex min-w-0 items-center gap-2">
            {condition ? <ConditionMark level={condition} size={8} /> : null}
            <span className="truncate text-[14px] font-medium text-sea-ink">{s.client_name}</span>
          </span>
          <span className="shrink-0 text-right">
            <span className="text-[14px] font-medium tabular-nums text-sea-ink">
              {s.eta ? (
                shortDate(s.eta, now)
              ) : (
                <span className="font-normal text-sea-ink-3">No ETA</span>
              )}
            </span>
            {s.eta && !voyage.arrived ? <TCount iso={s.eta} now={now} className="ml-2" /> : null}
          </span>
        </span>
        <span className="mt-2 block">
          <PassageLine s={s} voyage={voyage} target={target} now={now} cursor={false} />
        </span>
        {condition ? (
          <span className="mt-2 flex min-w-0 items-baseline gap-2 text-[12px]">
            <span className="shrink-0 font-medium text-sea-ink">{health.level}</span>
            <span className="truncate text-sea-ink-3">{health.reason}</span>
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
  sort?: { key: SortKey; dir: "asc" | "desc" };
  onSort?: (key: SortKey) => void;
  className?: string;
}) {
  const active = sortKey != null && sort?.key === sortKey;
  const inner = (
    <span className="chart-label inline-flex items-center gap-1">
      {children}
      {active ? (
        sort!.dir === "asc" ? (
          <ArrowUp className="size-3" />
        ) : (
          <ArrowDown className="size-3" />
        )
      ) : null}
    </span>
  );
  return (
    <th
      scope="col"
      aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : undefined}
      className={`whitespace-nowrap py-2 pr-4 font-normal text-sea-ink-3 ${className}`}
    >
      {sortKey && onSort ? (
        <button
          type="button"
          onClick={() => onSort(sortKey)}
          className={`focus-ring -mx-1 rounded-[1px] px-1 transition-colors hover:text-sea-ink ${active ? "text-sea-ink" : ""}`}
        >
          {inner}
        </button>
      ) : (
        inner
      )}
    </th>
  );
}
