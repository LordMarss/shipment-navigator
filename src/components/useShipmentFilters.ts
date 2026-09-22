import { useMemo, useState } from "react";

import { STATUSES, shortId, type Shipment, type ShipmentStatus } from "@/lib/api";

export type SortKey = "created_at" | "client_name" | "eta" | "landed_cost" | "status";

/**
 * Search, status/client filters and column sort for a shipment list. Shared
 * by ShipmentTable and the dashboard's fleet manifest so both lists filter
 * and sort identically.
 */
export function useShipmentFilters(shipments: Shipment[]) {
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

  return { query, setQuery, status, setStatus, client, setClient, clients, sort, toggleSort, rows };
}
