import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Search } from "lucide-react";

import { EmptyState, Skeleton, fieldClass } from "@/components/AppShell";
import { DocsIndicator, StatusPill } from "@/components/StatusPill";
import {
  STATUSES,
  formatCost,
  formatEta,
  shortId,
  type Shipment,
  type ShipmentDocument,
  type ShipmentStatus,
} from "@/lib/api";
import { docsFor } from "@/lib/insights";

type SortKey = "created_at" | "client_name" | "eta" | "landed_cost" | "status";

export function ShipmentTable({
  shipments,
  documents,
  isLoading,
  emptyTitle = "No shipments yet",
  emptyDescription = "Create your first shipment to start tracking documents, vessels and landed cost.",
  emptyAction,
}: {
  shipments: Shipment[];
  documents: ShipmentDocument[];
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
          {STATUSES.map((s) => (
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
              <Th>Origin</Th>
              <Th>Destination</Th>
              <Th>Vessel</Th>
              <Th sortKey="eta" sort={sort} onSort={toggleSort}>
                ETA
              </Th>
              <Th sortKey="status" sort={sort} onSort={toggleSort}>
                Status
              </Th>
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
                  <td colSpan={9} className="px-3 py-2.5">
                    <Skeleton className="h-4 w-full" />
                  </td>
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={9}>
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
                    <td className="px-3 py-2.5 text-muted-foreground">{s.origin}</td>
                    <td className="px-3 py-2.5 text-muted-foreground">{s.destination}</td>
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
