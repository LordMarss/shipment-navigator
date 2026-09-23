import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  listAlerts,
  listAllDocuments,
  listShipments,
  listVesselPositionsByMmsi,
  type Shipment,
} from "@/lib/api";

/**
 * The fleet as every board and page reads it: shipments, their documents,
 * the alert feed and live AIS positions, under the same query keys the
 * dashboard uses so pages share one cache. Read-only.
 */
export function useFleet(filter?: (s: Shipment) => boolean) {
  const { data: all = [], isLoading } = useQuery({
    queryKey: ["shipments"],
    queryFn: listShipments,
  });
  const { data: documents = [] } = useQuery({
    queryKey: ["documents", "all"],
    queryFn: listAllDocuments,
  });
  const { data: alerts = [] } = useQuery({ queryKey: ["alerts"], queryFn: listAlerts });

  const shipments = useMemo(() => (filter ? all.filter(filter) : all), [all, filter]);
  const mmsis = useMemo(
    () => shipments.map((s) => s.vessel_mmsi).filter((m): m is string => Boolean(m)),
    [shipments],
  );
  const { data: positions } = useQuery({
    queryKey: ["vesselPositions", mmsis],
    queryFn: () => listVesselPositionsByMmsi(mmsis),
    enabled: mmsis.length > 0,
    refetchInterval: 45_000,
  });

  return { all, shipments, documents, alerts, positions, isLoading };
}
