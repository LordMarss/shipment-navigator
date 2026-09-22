import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { AppShell } from "@/components/AppShell";
import { NewShipmentForm } from "@/components/NewShipmentForm";
import { ActivityLog } from "@/components/dashboard/ActivityLog";
import { Band } from "@/components/dashboard/glyphs";
import { Horizon } from "@/components/dashboard/Horizon";
import { Manifest, type Lens } from "@/components/dashboard/Manifest";
import { Masthead, type MastheadFacts } from "@/components/dashboard/Masthead";
import { useNow } from "@/components/dashboard/useNow";
import { WatchList, type WatchItem } from "@/components/dashboard/WatchList";
import { useMonitoringConfig } from "@/hooks/useMonitoringConfig";
import {
  isLegacyStatus,
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

  // Same verdict as `kpis` (and the sidebar), itemised: the masthead's
  // headline number always equals the at-risk/delayed rows here.
  const watch = useMemo<WatchItem[]>(() => {
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

  const facts = useMemo<MastheadFacts>(() => {
    const { atRisk, delayed } = kpis(shipments, documents, config);
    const exceptions = atRisk + delayed;
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
      exceptions,
      toReview: watch.length - exceptions,
      overdueDepartures: open.filter(
        (s) => !s.actual_departure && s.planned_etd && new Date(s.planned_etd).getTime() < t,
      ).length,
      nextArrival: upcoming[0] ?? null,
      underway,
      active: shipments.filter((s) => !isLegacyStatus(s.status) && s.status !== "Arrived").length,
      arriving72h: upcoming.filter((s) => new Date(s.eta!).getTime() <= t + 3 * DAY).length,
      etaRevised24h: etaRevised.size,
      missingDocs: open.filter((s) => {
        const d = docsFor(documents, s.id);
        return d.attached < d.total;
      }).length,
    };
  }, [shipments, documents, alerts, positions, config, now, watch.length]);

  const urgent = watch.filter((w) => w.health.level !== "Attention").length;

  return (
    <AppShell title="Operations" bare>
      {/* The operations sheet: neutral paper, graphite ink, one signal blue. */}
      <div className="min-h-[calc(100dvh-3.5rem)] bg-paper text-ink-1">
        <div className="mx-auto w-full max-w-[1520px] px-5 pb-6 [--ww-margin:188px] sm:px-8 lg:px-10 2xl:px-14 2xl:[--ww-margin:220px]">
          <Masthead
            facts={facts}
            now={now}
            lastSync={lastSync}
            isLoading={isLoading}
            formOpen={open}
            onToggleForm={() => setOpen((v) => !v)}
          />

          {open ? (
            <div id="new-shipment" className="pb-10 pt-2 xl:pl-[var(--ww-margin)]">
              <NewShipmentForm onClose={() => setOpen(false)} />
            </div>
          ) : null}

          <Band
            id="attention"
            title="Needs attention"
            meta={
              isLoading
                ? null
                : watch.length === 0
                  ? "All clear"
                  : [
                      urgent > 0 ? `${urgent} at risk or delayed` : null,
                      watch.length > urgent ? `${watch.length - urgent} to review` : null,
                    ]
                      .filter(Boolean)
                      .join(", ")
            }
          >
            <WatchList
              items={watch}
              isLoading={isLoading}
              focusId={focusId}
              onFocus={setFocusId}
              onShowAll={() => {
                setLens("attention");
                document.getElementById("fleet")?.scrollIntoView({ block: "start" });
              }}
            />
          </Band>

          <Band id="schedule" title="Schedule" meta="Planned departures and arrivals">
            <Horizon
              shipments={shipments}
              now={now}
              focusId={focusId}
              onFocus={setFocusId}
              isLoading={isLoading}
            />
          </Band>

          <Manifest
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

          <Band id="log" title="Log" meta="Latest events and alerts">
            <ActivityLog
              events={events}
              alerts={alerts}
              shipmentById={shipmentById}
              isLoading={alertsLoading || eventsLoading}
              now={now}
            />
          </Band>
        </div>
      </div>
    </AppShell>
  );
}
