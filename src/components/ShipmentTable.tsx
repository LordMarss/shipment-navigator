import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Package, Search, Ship } from "lucide-react";

import { EmptyState, Skeleton, fieldClass } from "@/components/AppShell";
import { DocsIndicator, HealthBadge, SeverityBadge, StatusPill, statusAccent, type StatusAccent } from "@/components/StatusPill";
import {
  ACTIVE_STATUSES,
  STATUSES,
  formatCost,
  formatEta,
  shortId,
  type Alert,
  type Shipment,
  type ShipmentDocument,
  type ShipmentStatus,
} from "@/lib/api";
import { alertSeverity, relativeTime, SEVERITY_LABEL, shipmentHealth, type Severity } from "@/lib/lifecycle";
import { docsFor } from "@/lib/insights";
import { useMonitoringConfig } from "@/hooks/useMonitoringConfig";

type SortKey = "created_at" | "client_name" | "eta" | "landed_cost" | "status";

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, attention: 1, informational: 2 };

const ROW_ACCENT: Record<StatusAccent, string> = {
  neutral: "hover:border-l-muted-foreground/40",
  primary: "hover:border-l-primary",
  positive: "hover:border-l-positive",
  warning: "hover:border-l-warning",
};

/** Small colored cue for how recently a shipment was touched — real data
 * (updated_at), not a decorative animation. */
function freshnessDot(updatedAt: string): string {
  const ageHours = (Date.now() - new Date(updatedAt).getTime()) / 3_600_000;
  if (ageHours < 1) return "bg-primary";
  if (ageHours < 24) return "bg-primary/45";
  return "bg-muted-foreground/30";
}

export function ShipmentTable({
  shipments,
  documents,
  alerts,
  isLoading,
  showClient = true,
  showLandedCost = true,
  showLastUpdated = false,
  emptyTitle = "No shipments yet",
  emptyDescription = "Create your first shipment to start tracking documents, vessels and landed cost.",
  emptyAction,
}: {
  shipments: Shipment[];
  documents: ShipmentDocument[];
  /** Optional — when passed, an "Alerts" column shows each shipment's worst open alert. */
  alerts?: Alert[];
  isLoading?: boolean;
  /** Default true, matching the existing /shipments/* list pages. */
  showClient?: boolean;
  /** Default true, matching the existing /shipments/* list pages. */
  showLandedCost?: boolean;
  /** Default false — an operational "last touched" column for the dashboard. */
  showLastUpdated?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: ReactNode;
}) {
  const navigate = useNavigate();
  const config = useMonitoringConfig();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<ShipmentStatus | "all">("all");
  const [client, setClient] = useState("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "created_at",
    dir: "desc",
  });

  const clients = useMemo(
    () => Array.from(new Set(shipments.map((s) => s.client_name))).sort(),
    [shipments],
  );

  const alertsByShipment = useMemo(() => {
    const map = new Map<string, { severity: Severity; count: number }>();
    for (const a of alerts ?? []) {
      if (!a.shipment_id) continue;
      const severity = alertSeverity(a);
      const existing = map.get(a.shipment_id);
      if (!existing) {
        map.set(a.shipment_id, { severity, count: 1 });
      } else {
        existing.count += 1;
        if (SEVERITY_RANK[severity] < SEVERITY_RANK[existing.severity]) existing.severity = severity;
      }
    }
    return map;
  }, [alerts]);

  const columnCount =
    6 + (showClient ? 1 : 0) + (alerts ? 1 : 0) + (showLandedCost ? 1 : 0) + (showLastUpdated ? 1 : 0);

  const rows = useMemo(() => {
    const term = query.trim().toLowerCase();
    const filtered = shipments.filter((s) => {
      if (status !== "all" && s.status !== status) return false;
      if (client !== "all" && s.client_name !== client) return false;
      if (!term) return true;
      return [
        shortId(s.id),
        s.client_name,
        s.origin,
        s.destination,
        s.vessel_name ?? "",
        s.vessel_mmsi ?? "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(term);
    });

    const dir = sort.dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      switch (sort.key) {
        case "client_name":
          return a.client_name.localeCompare(b.client_name) * dir;
        case "status":
          return (STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status)) * dir;
        case "landed_cost":
          return ((a.landed_cost ?? 0) - (b.landed_cost ?? 0)) * dir;
        case "eta": {
          const av = a.eta ? new Date(a.eta).getTime() : Number.MAX_SAFE_INTEGER;
          const bv = b.eta ? new Date(b.eta).getTime() : Number.MAX_SAFE_INTEGER;
          return (av - bv) * dir;
        }
        default:
          return (new Date(a.created_at).getTime() - new Date(b.created_at).getTime()) * dir;
      }
    });
  }, [shipments, query, status, client, sort]);

  const toggleSort = (key: SortKey) =>
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" },
    );

  return (
    <section className="panel overflow-hidden">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-border px-4 py-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            className={`${fieldClass} pl-8`}
            placeholder="Search ID, client, route, vessel or MMSI"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <select
          className={`${fieldClass} w-auto`}
          value={status}
          onChange={(e) => setStatus(e.target.value as ShipmentStatus | "all")}
        >
          <option value="all">All statuses</option>
          {ACTIVE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          className={`${fieldClass} w-auto`}
          value={client}
          onChange={(e) => setClient(e.target.value)}
        >
          <option value="all">All clients</option>
          {clients.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <span className="ml-auto text-xs text-muted-foreground">
          {rows.length} of {shipments.length}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[980px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border">
              <Th>Shipment</Th>
              {showClient ? (
                <Th sortKey="client_name" sort={sort} onSort={toggleSort}>
                  Client
                </Th>
              ) : null}
              <Th>Route</Th>
              <Th>Vessel</Th>
              <Th sortKey="status" sort={sort} onSort={toggleSort}>
                Status
              </Th>
              <Th sortKey="eta" sort={sort} onSort={toggleSort}>
                ETA
              </Th>
              {alerts ? <Th>Alerts</Th> : null}
              <Th>Documents</Th>
              {showLastUpdated ? <Th>Last Updated</Th> : null}
              {showLandedCost ? (
                <Th sortKey="landed_cost" sort={sort} onSort={toggleSort} align="right">
                  Landed Cost
                </Th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <tr key={i} className="border-b border-border last:border-0">
                  <td colSpan={columnCount} className="px-4 py-3">
                    <Skeleton className="h-4 w-full" />
                  </td>
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={columnCount}>
                  <EmptyState
                    icon={shipments.length === 0 ? Package : Search}
                    title={shipments.length === 0 ? emptyTitle : "No shipments match your filters"}
                    description={
                      shipments.length === 0
                        ? emptyDescription
                        : "Adjust the search term, status or client filter to widen the results."
                    }
                    action={shipments.length === 0 ? emptyAction : undefined}
                  />
                </td>
              </tr>
            ) : (
              rows.map((s) => {
                const docs = docsFor(documents, s.id);
                const shipmentAlert = alerts ? alertsByShipment.get(s.id) : undefined;
                const health = shipmentHealth(s, docs, config);
                const showHealth = health.level !== "On Track" && health.level !== "Delivered";
                const accent = ROW_ACCENT[statusAccent(s.status)];
                return (
                  <tr
                    key={s.id}
                    onClick={() => navigate({ to: "/shipments/$id", params: { id: s.id } })}
                    className={`group cursor-pointer border-b border-l-2 border-border border-l-transparent transition-colors duration-150 last:border-b-0 hover:bg-atmosphere/60 ${accent}`}
                  >
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground transition-colors group-hover:text-primary">
                      {shortId(s.id)}
                    </td>
                    {showClient ? <td className="px-4 py-3 font-medium">{s.client_name}</td> : null}
                    <td className="px-4 py-3 text-muted-foreground">
                      {s.origin} <span className="text-muted-foreground/50">→</span> {s.destination}
                    </td>
                    <td className="px-4 py-3">
                      {s.vessel_name ? (
                        <span className="inline-flex items-center gap-1.5 text-foreground">
                          <Ship className="size-3 shrink-0 text-muted-foreground/70" />
                          {s.vessel_name}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/70">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-0.5">
                        <StatusPill status={s.status} />
                        {showHealth ? <HealthBadge level={health.level} /> : null}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{formatEta(s.eta)}</td>
                    {alerts ? (
                      <td className="px-4 py-3">
                        {shipmentAlert ? (
                          <SeverityBadge
                            severity={shipmentAlert.severity}
                            label={
                              shipmentAlert.count > 1
                                ? `${SEVERITY_LABEL[shipmentAlert.severity]} (${shipmentAlert.count})`
                                : SEVERITY_LABEL[shipmentAlert.severity]
                            }
                          />
                        ) : (
                          <span className="text-muted-foreground/50">—</span>
                        )}
                      </td>
                    ) : null}
                    <td className="px-4 py-3">
                      <DocsIndicator attached={docs.attached} total={docs.total} />
                    </td>
                    {showLastUpdated ? (
                      <td className="px-4 py-3 text-muted-foreground">
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            className={`size-1.5 rounded-full ${freshnessDot(s.updated_at)}`}
                            aria-hidden
                          />
                          {relativeTime(s.updated_at)}
                        </span>
                      </td>
                    ) : null}
                    {showLandedCost ? (
                      <td className="px-4 py-3 text-right font-medium tabular-nums">
                        {formatCost(s.landed_cost)}
                      </td>
                    ) : null}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {rows.length > 0 ? (
        <div className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
          Select a row to open the shipment, or{" "}
          <Link to="/map" className="text-primary hover:underline">
            view the fleet map
          </Link>
          .
        </div>
      ) : null}
    </section>
  );
}

function Th({
  children,
  sortKey,
  sort,
  onSort,
  align = "left",
}: {
  children: ReactNode;
  sortKey?: SortKey;
  sort?: { key: SortKey; dir: "asc" | "desc" };
  onSort?: (key: SortKey) => void;
  align?: "left" | "right";
}) {
  const active = sortKey && sort?.key === sortKey;
  const content = (
    <span className={`inline-flex items-center gap-1 ${align === "right" ? "justify-end" : ""}`}>
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
      className={`px-4 py-2.5 text-xs font-medium uppercase tracking-[0.05em] text-muted-foreground ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {sortKey && onSort ? (
        <button
          type="button"
          className="focus-ring rounded-sm uppercase transition-colors hover:text-foreground"
          onClick={() => onSort(sortKey)}
        >
          {content}
        </button>
      ) : (
        content
      )}
    </th>
  );
}
