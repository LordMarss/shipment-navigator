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
  Band,
  DocsMeter,
  Mark,
  PhaseLabel,
  SignalBars,
  TCount,
  Skeleton,
} from "@/components/dashboard/glyphs";
import {
  ago,
  formatCoordinates,
  shortDate,
  signalOf,
  vesselReading,
} from "@/components/dashboard/format";

const DAY = 86_400_000;
const SEVERITY_RANK: Record<Severity, number> = { critical: 0, attention: 1, informational: 2 };
const FINISHED = new Set(["Arrived", "At Port", "Cleared Customs", "Delivered"]);
/** On phones the list keeps the first dozen and offers the rest on request. */
const COMPACT_LIMIT = 12;

export type Lens = "all" | "attention" | "underway" | "arriving";
const LENSES: { key: Lens; label: string }[] = [
  { key: "all", label: "All shipments" },
  { key: "attention", label: "Needs attention" },
  { key: "underway", label: "Under way" },
  { key: "arriving", label: "Arriving in 72h" },
];

type Row = {
  s: Shipment;
  health: Health;
  flagged: boolean;
  risk: boolean;
  docs: { attached: number; total: number };
  alerts: { count: number; severity: Severity } | undefined;
  position: VesselPosition | null;
  condition: ReturnType<typeof deriveVesselCondition>["kind"] | null;
  finished: boolean;
};

const field =
  "focus-ring h-8 w-full rounded-[2px] border border-rule-1 bg-paper px-2.5 text-[13px] text-ink-1 transition-colors placeholder:text-ink-3 hover:border-ink-3";

/**
 * The fleet manifest. Same search, filters and sort as every other
 * shipment list (via `useShipmentFilters`), plus lenses for the three
 * questions a coordinator actually asks of it. A row reads left to right:
 * who, where between origin and destination, which phase, the vessel's
 * signal, when, and anything that needs a look. Colour appears only at
 * the row's edge (a problem) and in the glyphs (movement, completion).
 */
export function Manifest({
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
        return {
          s,
          health,
          flagged:
            health.level === "At Risk" ||
            health.level === "Delayed" ||
            health.level === "Attention",
          risk: health.level === "At Risk" || health.level === "Delayed",
          docs,
          alerts: alertsByShipment.get(s.id),
          position,
          condition: positions && s.vessel_mmsi ? deriveVesselCondition(s, position).kind : null,
          finished: FINISHED.has(s.status) || Boolean(s.actual_arrival),
        };
      }),
    [rows, documents, config, positions, alertsByShipment],
  );

  const matches = (r: Row, l: Lens) => {
    if (l === "attention") return r.flagged;
    if (l === "underway") return r.condition === "underway";
    if (l === "arriving") {
      if (r.finished || !r.s.eta || now == null) return false;
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

  const controls = (
    <div className="flex flex-col gap-4 xl:gap-6">
      <div
        role="group"
        aria-label="Show"
        className="-mx-1 flex gap-1 overflow-x-auto xl:mx-0 xl:flex-col xl:gap-0"
      >
        {LENSES.map((l) => {
          const active = lens === l.key;
          return (
            <button
              key={l.key}
              type="button"
              aria-pressed={active}
              aria-label={isLoading ? l.label : `${l.label}, ${counts[l.key]}`}
              onClick={() => setLens(l.key)}
              className={`focus-ring group relative flex shrink-0 items-baseline justify-between gap-3 whitespace-nowrap rounded-[1px] px-2 py-1.5 text-[13px] transition-colors xl:py-[7px] xl:pl-3 ${
                active ? "font-medium text-ink-1" : "text-ink-2 hover:text-ink-1"
              }`}
            >
              <span
                aria-hidden
                className={`absolute bottom-0 left-2 right-2 h-[2px] xl:inset-y-1 xl:left-0 xl:right-auto xl:h-auto xl:w-[2px] ${
                  active ? "bg-signal" : "bg-transparent group-hover:bg-rule-1"
                }`}
              />
              {l.label}
              <span className={`telemetry text-[11.5px] ${active ? "text-ink-1" : "text-ink-3"}`}>
                {isLoading ? "" : counts[l.key]}
              </span>
            </button>
          );
        })}
      </div>

      <div className="grid gap-2 sm:grid-cols-[minmax(0,15rem)_auto_auto] xl:grid-cols-1">
        <label className="relative block">
          <span className="sr-only">Search shipments</span>
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-3"
          />
          <input
            className={`${field} pl-8`}
            placeholder="ID, client, route, vessel, MMSI"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <select
          className={field}
          aria-label="Filter by status"
          value={status}
          onChange={(e) => setStatus(e.target.value as ShipmentStatus | "all")}
        >
          <option value="all">Any status</option>
          {ACTIVE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          className={`${field} sm:max-w-[13rem] xl:max-w-none`}
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
    <Band
      id="fleet"
      title="Fleet"
      meta={
        isLoading
          ? null
          : visible.length === shipments.length
            ? `${shipments.length} shipment${shipments.length === 1 ? "" : "s"}`
            : `${visible.length} of ${shipments.length} shown`
      }
      aside={controls}
    >
      {/* Wide: the manifest table */}
      <table className="hidden w-full table-fixed border-collapse text-left md:table">
        <colgroup>
          <col className="w-[24%] xl:w-[19%]" />
          <col className="w-[30%] xl:w-[24%]" />
          <col className="w-[17%] xl:w-[14%]" />
          <col className="hidden w-[16%] xl:table-column" />
          <col className="w-[14%] xl:w-[10%]" />
          <col className="w-[15%] xl:w-[10%]" />
          <col className="hidden w-[9%] xl:table-column" />
          <col className="hidden w-[6%] min-[1440px]:table-column" />
        </colgroup>
        <thead
          className={`sticky top-14 z-[5] bg-paper ${!isLoading && shipments.length === 0 ? "hidden" : ""}`}
        >
          <tr className="shadow-[inset_0_-1px_0_var(--ww-rule-1)]">
            <Th sortKey="client_name" sort={sort} onSort={toggleSort}>
              Shipment
            </Th>
            <Th>Passage</Th>
            <Th sortKey="status" sort={sort} onSort={toggleSort}>
              Phase
            </Th>
            <Th className="hidden xl:table-cell">Vessel signal</Th>
            <Th sortKey="eta" sort={sort} onSort={toggleSort}>
              ETA
            </Th>
            <Th>Watch</Th>
            <Th className="hidden xl:table-cell">Docs</Th>
            <Th className="hidden text-right min-[1440px]:table-cell">Updated</Th>
          </tr>
        </thead>
        <tbody>
          {isLoading
            ? Array.from({ length: 5 }).map((_, i) => (
                <tr key={i} className="border-b border-rule-2">
                  <td className="py-3.5 pl-4 pr-4">
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="mt-2 h-3 w-16" />
                  </td>
                  <td className="py-3.5 pr-4">
                    <Skeleton className="h-4 w-4/5" />
                    <Skeleton className="mt-2.5 h-1 w-3/4" />
                  </td>
                  <td className="py-3.5 pr-4">
                    <Skeleton className="h-4 w-20" />
                  </td>
                  <td className="hidden py-3.5 pr-4 xl:table-cell">
                    <Skeleton className="h-4 w-24" />
                  </td>
                  <td className="py-3.5 pr-4">
                    <Skeleton className="h-4 w-14" />
                  </td>
                  <td className="py-3.5 pr-4" />
                  <td className="hidden xl:table-cell" />
                  <td className="hidden min-[1440px]:table-cell" />
                </tr>
              ))
            : visible.map((r) => (
                <ManifestRow
                  key={r.s.id}
                  row={r}
                  now={now}
                  focused={focusId === r.s.id}
                  onFocus={onFocus}
                  onOpen={() => navigate({ to: "/shipments/$id", params: { id: r.s.id } })}
                />
              ))}
        </tbody>
      </table>

      {/* Narrow: a ruled list keeping only who, phase, when and any flag */}
      <ul className="border-t border-rule-1 md:hidden">
        {isLoading
          ? Array.from({ length: 4 }).map((_, i) => (
              <li key={i} className="space-y-2 border-b border-rule-2 py-4">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-1/2" />
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
          className="focus-ring mt-3 w-full rounded-[2px] border border-rule-1 py-2.5 text-[13px] font-medium text-ink-1 hover:bg-wash md:hidden"
        >
          Show all {visible.length}
        </button>
      ) : null}

      {!isLoading && visible.length === 0 ? (
        <div className="border-b border-rule-2 py-10">
          {shipments.length === 0 ? (
            <>
              <p className="text-[14px] font-medium text-ink-1">No shipments yet</p>
              <p className="mt-1 max-w-[52ch] text-[13px] text-ink-2">
                Create the first with New shipment above to start tracking vessels, documents and
                arrival dates.
              </p>
            </>
          ) : (
            <>
              <p className="text-[14px] font-medium text-ink-1">Nothing matches this view</p>
              <p className="mt-1 text-[13px] text-ink-2">
                {filtered
                  ? "Widen the search or filters to see more shipments."
                  : "No shipments to show."}
              </p>
              {filtered ? (
                <button
                  type="button"
                  onClick={clearAll}
                  className="focus-ring mt-3 rounded-[1px] text-[13px] font-medium text-signal hover:underline"
                >
                  Clear search and filters
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {!isLoading && visible.length > 0 ? (
        <p className="mt-3 text-[12px] text-ink-3">
          Select a shipment to open it, or{" "}
          <Link to="/map" className="text-signal hover:underline">
            view the fleet map
          </Link>
          .
        </p>
      ) : null}
    </Band>
  );
}

function ManifestRow({
  row,
  now,
  focused,
  onFocus,
  onOpen,
}: {
  row: Row;
  now: number | null;
  focused: boolean;
  onFocus: (id: string | null) => void;
  onOpen: () => void;
}) {
  const { s, health, flagged, risk, docs, alerts, position, condition, finished } = row;
  const signal = signalOf(position, now);
  const reading = vesselReading(condition, position, Boolean(s.vessel_mmsi), signal);

  return (
    <tr
      onClick={onOpen}
      onMouseEnter={() => onFocus(s.id)}
      onMouseLeave={() => onFocus(null)}
      className={`group cursor-pointer border-b border-rule-2 align-top transition-colors duration-100 ${
        focused ? "bg-signal-wash" : "hover:bg-wash"
      }`}
    >
      <td className="relative py-3.5 pl-4 pr-4">
        {flagged ? (
          <span
            aria-hidden
            className={`absolute inset-y-0 left-0 w-[3px] ${risk ? "bg-alert" : "bg-caution"}`}
          />
        ) : null}
        <Link
          to="/shipments/$id"
          params={{ id: s.id }}
          onClick={(e) => e.stopPropagation()}
          onFocus={() => onFocus(s.id)}
          onBlur={() => onFocus(null)}
          className="focus-ring block truncate rounded-[1px] text-[14px] font-medium text-ink-1"
        >
          {s.client_name}
        </Link>
        <span className="telemetry mt-1 block truncate text-[11px] text-ink-3">
          {shortId(s.id)}
        </span>
      </td>

      <td className="py-3.5 pr-6">
        <span
          className="flex min-w-0 items-baseline gap-1.5 text-[13px]"
          title={`${s.origin} to ${s.destination}`}
        >
          <span className="truncate text-ink-2">{s.origin}</span>
          <span aria-hidden className="shrink-0 text-ink-4">
            →
          </span>
          <span className="truncate text-ink-1">{s.destination}</span>
        </span>
        <Passage s={s} now={now} finished={finished} />
      </td>

      <td className="py-3.5 pr-4 text-[13px] text-ink-2">
        <PhaseLabel status={s.status} />
      </td>

      <td className="hidden py-3.5 pr-4 xl:table-cell">
        {s.vessel_name ? (
          <>
            <span className="block truncate text-[13px] text-ink-1">{s.vessel_name}</span>
            <span
              className="mt-1.5 flex items-center gap-2 text-[11.5px]"
              title={
                position && signal.state !== "none"
                  ? `Last fix ${signal.age} ago at ${formatCoordinates(position.latitude, position.longitude)}`
                  : "No AIS position received"
              }
            >
              <SignalBars signal={signal} moving={reading.moving} />
              <span className={`truncate ${reading.moving ? "telemetry" : ""} ${reading.tone}`}>
                {reading.text}
              </span>
              {signal.age ? (
                <span className="telemetry shrink-0 text-ink-3">{signal.age}</span>
              ) : null}
            </span>
          </>
        ) : (
          <span className="text-[13px] text-ink-3">Not assigned</span>
        )}
      </td>

      <td className="py-3.5 pr-4">
        {s.eta ? (
          <>
            <span
              className="block text-[13.5px] font-medium tabular-nums text-ink-1"
              title={formatEta(s.eta)}
            >
              {shortDate(s.eta, now)}
            </span>
            <span className="mt-1 block">
              {finished ? (
                <span className="text-[11.5px] text-ink-3">Arrived</span>
              ) : (
                <TCount iso={s.eta} now={now} />
              )}
            </span>
          </>
        ) : (
          <span className="text-[13px] text-ink-3">Not set</span>
        )}
      </td>

      <td className="py-3.5 pr-4">
        {flagged ? (
          <span className="block text-[12.5px] font-medium text-ink-1" title={health.reason}>
            {health.level}
          </span>
        ) : (
          <span className="sr-only">Clear</span>
        )}
        {alerts ? (
          <span className="mt-1 block text-[11.5px] text-ink-3">
            {alerts.count} alert{alerts.count === 1 ? "" : "s"}
          </span>
        ) : null}
      </td>

      <td className="hidden py-3.5 pr-4 xl:table-cell">
        <DocsMeter attached={docs.attached} total={docs.total} />
      </td>

      <td className="hidden py-3.5 pr-4 text-right min-[1440px]:table-cell">
        {now != null ? (
          <span
            className="telemetry text-[11px] text-ink-3"
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
 * The passage between origin and destination, by schedule: elapsed share
 * of actual departure → current ETA. Time-based, not a position fix, and
 * labelled that way. Before departure it states the planned ETD instead.
 * Same marks as the schedule: hollow square = departure point, filled =
 * the vessel's estimated position (blue while under way).
 */
function Passage({ s, now, finished }: { s: Shipment; now: number | null; finished: boolean }) {
  const departed = Boolean(s.actual_departure);
  let progress: number | null = null;
  let note: ReactNode = null;
  let label: string;

  if (finished) {
    progress = 1;
    label = "Passage complete";
    note = <span className="text-ink-3">Complete</span>;
  } else if (!departed) {
    progress = 0;
    if (s.planned_etd && now != null) {
      const overdue = new Date(s.planned_etd).getTime() < now;
      label = `Not yet departed, planned ${formatEta(s.planned_etd)}`;
      note = (
        <span className={overdue ? "font-medium text-alert" : "text-ink-3"}>
          ETD {shortDate(s.planned_etd, now)}
        </span>
      );
    } else {
      label = "Not yet departed";
      note = <span className="text-ink-3">Not sailed</span>;
    }
  } else if (s.eta && now != null) {
    const dep = new Date(s.actual_departure!).getTime();
    const eta = new Date(s.eta).getTime();
    progress = eta > dep ? Math.min(1, Math.max(0, (now - dep) / (eta - dep))) : 1;
    const total = Math.max(1, Math.round((eta - dep) / DAY));
    const elapsed = Math.min(total, Math.max(0, Math.round((now - dep) / DAY)));
    label = `Day ${elapsed} of ${total} by schedule`;
    note = (
      <span className="text-ink-3">
        Day <span className="telemetry text-ink-2">{elapsed}</span>/
        <span className="telemetry">{total}</span>
      </span>
    );
  } else {
    label = "Departed, no ETA to measure against";
    note = <span className="text-ink-3">No ETA</span>;
  }

  const underway = departed && !finished && progress != null;

  return (
    <span className="mt-2 flex items-center gap-3" title={label}>
      <span className="relative block h-[7px] min-w-0 flex-1" role="img" aria-label={label}>
        <span
          className={`absolute inset-x-0 top-1/2 -translate-y-1/2 ${
            progress == null ? "border-t border-dashed border-ink-4" : "h-px bg-off"
          }`}
        />
        {progress != null && progress > 0 ? (
          <span
            className={`absolute left-0 top-1/2 h-px -translate-y-1/2 ${finished ? "bg-ink-3" : "bg-signal"}`}
            style={{ width: `${progress * 100}%` }}
          />
        ) : null}
        <span className="absolute left-0 top-0 h-[7px] w-px bg-ink-3" />
        <span className="absolute right-0 top-0 h-[7px] w-px bg-ink-3" />
        {underway ? (
          <span
            className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${progress! * 100}%` }}
          >
            <Mark filled tone="signal" size={6} className="block" />
          </span>
        ) : !departed && !finished ? (
          <span className="absolute left-0 top-1/2 -translate-x-1/2 -translate-y-1/2">
            <Mark filled={false} tone="quiet" size={6} className="block" />
          </span>
        ) : null}
      </span>
      <span className="shrink-0 text-[11.5px]">{note}</span>
    </span>
  );
}

function CompactRow({ row, now }: { row: Row; now: number | null }) {
  const { s, health, flagged, risk, finished } = row;
  return (
    <li className="border-b border-rule-2">
      <Link
        to="/shipments/$id"
        params={{ id: s.id }}
        className="focus-ring relative grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 py-3 pl-3.5 hover:bg-wash"
      >
        {flagged ? (
          <span
            aria-hidden
            className={`absolute inset-y-0 left-0 w-[3px] ${risk ? "bg-alert" : "bg-caution"}`}
          />
        ) : null}
        <span className="truncate text-[14px] font-medium text-ink-1">{s.client_name}</span>
        <span className="text-right text-[13.5px] font-medium tabular-nums text-ink-1">
          {s.eta ? shortDate(s.eta, now) : <span className="font-normal text-ink-3">No ETA</span>}
        </span>
        <PhaseLabel status={s.status} className="text-[12.5px] text-ink-2" />
        <span className="text-right">
          {s.eta && !finished ? <TCount iso={s.eta} now={now} /> : null}
        </span>
        {flagged ? (
          <span className="col-span-2 flex min-w-0 items-baseline gap-2 text-[12px]">
            <span className="shrink-0 font-medium text-ink-1">{health.level}</span>
            <span className="truncate text-ink-3">{health.reason}</span>
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
    <span className="inline-flex items-center gap-1">
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
      className={`whitespace-nowrap py-2.5 pr-4 text-[11.5px] font-normal text-ink-3 first:pl-4 ${className}`}
    >
      {sortKey && onSort ? (
        <button
          type="button"
          onClick={() => onSort(sortKey)}
          className={`focus-ring -mx-1 rounded-[1px] px-1 transition-colors hover:text-ink-1 ${active ? "font-medium text-ink-1" : ""}`}
        >
          {inner}
        </button>
      ) : (
        inner
      )}
    </th>
  );
}
