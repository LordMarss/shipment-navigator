import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { AppShell } from "@/components/AppShell";
import { NewShipmentForm } from "@/components/NewShipmentForm";
import { Almanac } from "@/components/dashboard/Almanac";
import { DeckLog } from "@/components/dashboard/DeckLog";
import { SituationBar, type SituationFacts } from "@/components/dashboard/SituationBar";
import { useNow } from "@/components/maritime/useNow";
import { VoyageBoard, type Lens } from "@/components/maritime/VoyageBoard";
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
 * Operations. The watch summary leads (what needs intervention, what is
 * moving, arriving and changed); the passage board is the working canvas,
 * grouped so the voyages that need a decision come first; the next
 * movements and the deck log run beside it. Pointing at a voyage in the
 * movements list marks the same voyage on the board.
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
    queryFn: () => listAllEvents(10),
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

  // Shipments whose ETA was revised in the last day: the "Changed" reading
  // and the board lens behind it.
  const changedIds = useMemo(() => {
    const t = now ?? 0;
    return new Set(
      alerts
        .filter(
          (a) =>
            a.shipment_id &&
            a.message.toLowerCase().includes("eta changed") &&
            new Date(a.created_at).getTime() >= t - DAY,
        )
        .map((a) => a.shipment_id!),
    );
  }, [alerts, now]);

  const facts = useMemo<SituationFacts>(() => {
    // Same verdict as `kpis` (and the rail's alarm count).
    const { atRisk, delayed } = kpis(shipments, documents, config);
    const alarm = atRisk + delayed;
    const flagged = shipments.filter((s) => {
      if (s.status === "Delivered") return false;
      const level = shipmentHealth(s, docsFor(documents, s.id), config).level;
      return level === "At Risk" || level === "Delayed" || level === "Attention";
    }).length;
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
    const latest = [
      ...events.map((e) => ({ at: e.occurred_at, shipmentId: e.shipment_id as string | null })),
      ...alerts.map((a) => ({ at: a.created_at, shipmentId: a.shipment_id })),
    ].sort((a, b) => b.at.localeCompare(a.at))[0];
    const upcoming = open
      .filter((s) => s.eta && !s.actual_arrival && new Date(s.eta).getTime() > t)
      .sort((a, b) => new Date(a.eta!).getTime() - new Date(b.eta!).getTime());
    return {
      alarm,
      caution: flagged - alarm,
      underway,
      inPassage: open.filter((s) => Boolean(s.actual_departure) && !s.actual_arrival).length,
      arriving72h: upcoming.filter((s) => new Date(s.eta!).getTime() <= t + 3 * DAY).length,
      etaRevised24h: changedIds.size,
      docsOpen: open.filter((s) => {
        const d = docsFor(documents, s.id);
        return d.attached < d.total;
      }).length,
      overdueDepartures: open.filter(
        (s) => !s.actual_departure && s.planned_etd && new Date(s.planned_etd).getTime() < t,
      ).length,
      nextArrival: upcoming[0] ?? null,
      latestChange: latest
        ? {
            at: new Date(latest.at).getTime(),
            client: latest.shipmentId
              ? (shipmentById.get(latest.shipmentId)?.client_name ?? null)
              : null,
          }
        : null,
    };
  }, [shipments, documents, positions, config, now, changedIds, events, alerts, shipmentById]);

  const chooseLens = (next: Lens) => {
    setLens(next);
    if (next !== "all")
      document.getElementById("board")?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  return (
    <AppShell title="Operations" bare>
      <SituationBar
        facts={facts}
        now={now}
        lastSync={lastSync}
        isLoading={isLoading}
        lens={lens}
        onLens={chooseLens}
        formOpen={open}
        onToggleForm={() => setOpen((v) => !v)}
      />

      <div className="mx-auto w-full max-w-[1600px] px-4 pb-12 pt-6 sm:px-6 lg:px-8">
        {open ? (
          <div id="new-shipment" className="animate-in mb-8">
            <NewShipmentForm onClose={() => setOpen(false)} />
          </div>
        ) : null}

        <div className="grid gap-x-10 gap-y-10 xl:grid-cols-[minmax(0,1fr)_320px] 2xl:grid-cols-[minmax(0,1fr)_352px]">
          <div className="min-w-0">
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
              showLenses={false}
              changedIds={changedIds}
            />
          </div>

          <aside
            aria-label="Schedule and log"
            className="grid content-start gap-x-10 gap-y-10 md:grid-cols-2 xl:grid-cols-1"
          >
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
          </aside>
        </div>
      </div>
    </AppShell>
  );
}
