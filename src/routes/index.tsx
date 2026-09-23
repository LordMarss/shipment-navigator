import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { AppShell } from "@/components/AppShell";
import { NewShipmentForm } from "@/components/NewShipmentForm";
import { Almanac } from "@/components/dashboard/Almanac";
import { BridgeStrip, type BridgeFacts } from "@/components/dashboard/BridgeStrip";
import { Conditions, type ConditionItem } from "@/components/dashboard/Conditions";
import { DeckLog } from "@/components/dashboard/DeckLog";
import { useNow } from "@/components/dashboard/useNow";
import { VoyageBoard, type Lens } from "@/components/dashboard/VoyageBoard";
import { useMonitoringConfig } from "@/hooks/useMonitoringConfig";
import {
  listAllDocuments,
  listAllEvents,
  listAlerts,
  listShipments,
  listVesselPositionsByMmsi,
} from "@/lib/api";
import { deriveVesselCondition } from "@/lib/aisAutomation";
import { docsFor, kpis, shipmentHealth } from "@/lib/lifecycle";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Dashboard - StimTech Solutions" },
      {
        name: "description",
        content:
          "Every shipment in one dense table: client, route, planned dates, pipeline status and landed cost.",
      },
      { property: "og:title", content: "Dashboard - StimTech Solutions" },
      {
        property: "og:description",
        content: "Track client shipments, routes, schedule, status and landed cost in one place.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Dashboard,
});

const DAY = 86_400_000;
const FINISHED = new Set(["Arrived", "At Port", "Cleared Customs", "Delivered"]);

/**
 * The operations sheet. One open, ruled surface in three bands of
 * priority: what needs a decision, what happens next, and the whole fleet
 * in motion, followed by the watch log. Hovering a shipment anywhere
 * (watch list, schedule, manifest) marks the same shipment everywhere else.
 */
function Dashboard() {
  const [open, setOpen] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [lens, setLens] = useState<Lens>("all");
  const config = useMonitoringConfig();
  const now = useNow();

  const { data: shipments = [], isLoading } = useQuery({
    queryKey: ["shipments"],
    queryFn: listShipments,
  });
  const { data: documents = [] } = useQuery({
    queryKey: ["documents", "all"],
    queryFn: listAllDocuments,
  });
  const { data: alerts = [], isLoading: alertsLoading } = useQuery({
    queryKey: ["alerts"],
    queryFn: listAlerts,
  });
  const { data: events = [], isLoading: eventsLoading } = useQuery({
    queryKey: ["events", "recent"],
    queryFn: () => listAllEvents(6),
  });

  const mmsis = useMemo(
    () => shipments.map((s) => s.vessel_mmsi).filter((m): m is string => Boolean(m)),
    [shipments],
  );
  // Live telemetry for the whole fleet in one query, refreshed on an
  // interval so a vessel that starts moving shows without a reload.
  const { data: positions } = useQuery({
    queryKey: ["vesselPositions", mmsis],
    queryFn: () => listVesselPositionsByMmsi(mmsis),
    enabled: mmsis.length > 0,
    refetchInterval: 45_000,
  });

  // The automated status pipeline runs server-side on a schedule; this only
  // reports when it last ran.
  const lastSync = shipments
    .map((s) => s.last_synced_at)
    .filter((v): v is string => Boolean(v))
    .sort()
    .pop();

  const shipmentById = useMemo(() => new Map(shipments.map((s) => [s.id, s])), [shipments]);

  // Same verdict as `kpis` (and the sidebar), itemised: the bridge strip's
  // alarm count always equals the at-risk/delayed entries here.
  const watch = useMemo<ConditionItem[]>(() => {
    const alertCounts = new Map<string, number>();
    for (const a of alerts) {
      if (a.shipment_id) alertCounts.set(a.shipment_id, (alertCounts.get(a.shipment_id) ?? 0) + 1);
    }
    return shipments
      .filter((s) => s.status !== "Delivered")
      .map((shipment) => ({
        shipment,
        health: shipmentHealth(shipment, docsFor(documents, shipment.id), config),
        alertCount: alertCounts.get(shipment.id) ?? 0,
      }))
      .filter(
        ({ health }) =>
          health.level === "At Risk" || health.level === "Delayed" || health.level === "Attention",
      );
  }, [shipments, documents, alerts, config]);

  const facts = useMemo<BridgeFacts>(() => {
    const { atRisk, delayed } = kpis(shipments, documents, config);
    const alarm = atRisk + delayed;
    // "Under way" is read from real AIS telemetry, not the status field.
    const underway = positions
      ? shipments.filter(
          (s) =>
            s.vessel_mmsi &&
            deriveVesselCondition(s, positions.get(s.vessel_mmsi) ?? null).kind === "underway",
        ).length
      : 0;
    const open = shipments.filter((s) => !FINISHED.has(s.status));
    const t = now ?? 0;
    const upcoming = open
      .filter((s) => s.eta && !s.actual_arrival && new Date(s.eta).getTime() > t)
      .sort((a, b) => new Date(a.eta!).getTime() - new Date(b.eta!).getTime());
    const etaRevised = new Set(
      alerts
        .filter(
          (a) =>
            a.shipment_id &&
            a.message.toLowerCase().includes("eta changed") &&
            new Date(a.created_at).getTime() >= t - DAY,
        )
        .map((a) => a.shipment_id),
    );
    return {
      alarm,
      caution: watch.length - alarm,
      underway,
      inPassage: open.filter((s) => Boolean(s.actual_departure) && !s.actual_arrival).length,
      arriving72h: upcoming.filter((s) => new Date(s.eta!).getTime() <= t + 3 * DAY).length,
      etaRevised24h: etaRevised.size,
      docsOpen: open.filter((s) => {
        const d = docsFor(documents, s.id);
        return d.attached < d.total;
      }).length,
      overdueDepartures: open.filter(
        (s) => !s.actual_departure && s.planned_etd && new Date(s.planned_etd).getTime() < t,
      ).length,
      nextArrival: upcoming[0] ?? null,
    };
  }, [shipments, documents, alerts, positions, config, now, watch.length]);

  const showConditionsOnBoard = () => {
    setLens("attention");
    document.getElementById("board")?.scrollIntoView({ block: "start" });
  };

  return (
    <AppShell title="Operations" bare chrome="bridge">
      <BridgeStrip
        facts={facts}
        now={now}
        lastSync={lastSync}
        isLoading={isLoading}
        formOpen={open}
        onToggleForm={() => setOpen((v) => !v)}
      />

      {/* The chart table: paper with a sparse graticule. */}
      <div className="chart-paper min-h-[calc(100dvh-3.5rem)] text-sea-ink">
        <div className="mx-auto w-full max-w-[1560px] px-5 pb-12 pt-7 sm:px-8 lg:px-10">
          {open ? (
            <div id="new-shipment" className="mb-9">
              <NewShipmentForm onClose={() => setOpen(false)} />
            </div>
          ) : null}

          {/* Conditions lead on narrow screens; on wide screens the board is
           * the canvas and the watch column runs beside it. */}
          <div className="grid gap-x-10 gap-y-10 xl:grid-cols-[minmax(0,1fr)_minmax(320px,368px)]">
            <div className="xl:col-start-2 xl:row-start-1">
              <Conditions
                items={watch}
                isLoading={isLoading}
                focusId={focusId}
                onFocus={setFocusId}
                onShowAll={showConditionsOnBoard}
              />
            </div>

            <div className="min-w-0 xl:col-start-1 xl:row-span-2 xl:row-start-1">
              <VoyageBoard
                shipments={shipments}
                documents={documents}
                alerts={alerts}
                positions={positions}
                isLoading={isLoading}
                now={now}
                focusId={focusId}
                onFocus={setFocusId}
                lens={lens}
                onLensChange={setLens}
              />
            </div>

            <div className="grid content-start gap-x-10 gap-y-10 md:grid-cols-2 xl:col-start-2 xl:row-start-2 xl:grid-cols-1">
              <Almanac
                shipments={shipments}
                now={now}
                isLoading={isLoading}
                focusId={focusId}
                onFocus={setFocusId}
              />
              <DeckLog
                events={events}
                alerts={alerts}
                shipmentById={shipmentById}
                isLoading={alertsLoading || eventsLoading}
                now={now}
              />
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
