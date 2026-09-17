import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Search } from "lucide-react";

import { EmptyState, Skeleton, fieldClass } from "@/components/AppShell";
import { DocsIndicator, SeverityBadge, StatusPill } from "@/components/StatusPill";
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
import { alertSeverity, SEVERITY_LABEL, type Severity } from "@/lib/lifecycle";
import { docsFor } from "@/lib/insights";

type SortKey = "created_at" | "client_name" | "eta" | "landed_cost" | "status";

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, attention: 1, informational: 2 };

export function ShipmentTable({
  shipments,
  documents,
  alerts,
  isLoading,
  emptyTitle = "No shipments yet",
  emptyDescription = "Create your first shipment to start tracking documents, vessels and landed cost.",
  emptyAction,
}: {
  shipments: Shipment[];
  documents: ShipmentDocument[];
  /** Optional — when passed, an "Alerts" column shows each shipment's worst open alert. */
  alerts?: Alert[];
  isLoading?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: ReactNode;
}) {
  const navigate = useNavigate();
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

  const columnCount = 8 + (alerts ? 1 : 0);

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
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
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
        <span className="ml-auto text-[12px] text-muted-foreground">
          {rows.length} of {shipments.length}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[980px] border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-border bg-subtle/60">
              <Th>Shipment ID</Th>
              <Th sortKey="client_name" sort={sort} onSort={toggleSort}>
                Client
              </Th>
              <Th>Route</Th>
              <Th>Vessel</Th>
              <Th sortKey="eta" sort={sort} onSort={toggleSort}>
                ETA
              </Th>
              <Th sortKey="status" sort={sort} onSort={toggleSort}>
                Status
              </Th>
              {alerts ? <Th>Alerts</Th> : null}
              <Th>Documents</Th>
              <Th sortKey="landed_cost" sort={sort} onSort={toggleSort} align="right">
                Landed Cost
              </Th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <tr key={i} className="border-b border-border last:border-0">
                  <td colSpan={columnCount} className="px-3 py-2.5">
                    <Skeleton className="h-4 w-full" />
                  </td>
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={columnCount}>
                  <EmptyState
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
                return (
                  <tr
                    key={s.id}
                    onClick={() => navigate({ to: "/shipments/$id", params: { id: s.id } })}
                    className="group cursor-pointer border-b border-border last:border-0 transition-colors hover:bg-subtle/70"
                  >
                    <td className="px-3 py-2.5 font-mono text-[12px] text-muted-foreground group-hover:text-primary">
                      {shortId(s.id)}
                    </td>
                    <td className="px-3 py-2.5 font-medium">{s.client_name}</td>
                    <td className="px-3 py-2.5 text-muted-foreground">
                      {s.origin} <span className="text-muted-foreground/50">→</span> {s.destination}
                    </td>
                    <td className="px-3 py-2.5">
                      {s.vessel_name ? (
                        <span className="text-foreground">{s.vessel_name}</span>
                      ) : (
                        <span className="text-muted-foreground/70">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">{formatEta(s.eta)}</td>
                    <td className="px-3 py-2.5">
                      <StatusPill status={s.status} />
                    </td>
                    {alerts ? (
                      <td className="px-3 py-2.5">
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
                    <td className="px-3 py-2.5">
                      <DocsIndicator attached={docs.attached} total={docs.total} />
                    </td>
                    <td className="px-3 py-2.5 text-right font-medium tabular-nums">
                      {formatCost(s.landed_cost)}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {rows.length > 0 ? (
        <div className="border-t border-border px-3 py-2 text-[12px] text-muted-foreground">
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
      className={`px-3 py-2 text-[11px] font-medium uppercase tracking-[0.05em] text-muted-foreground ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {sortKey && onSort ? (
        <button
          type="button"
          className="focus-ring rounded-sm transition-colors hover:text-foreground"
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
