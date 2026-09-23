import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { Plus, X } from "lucide-react";

import { AppShell, btnGhost, btnPrimary } from "@/components/AppShell";
import { NewShipmentForm } from "@/components/NewShipmentForm";
import { Almanac } from "@/components/dashboard/Almanac";
import { DeckLog } from "@/components/dashboard/DeckLog";
import { AtSea } from "@/components/dashboard/AtSea";
import { AttentionQueue } from "@/components/dashboard/AttentionQueue";
import { utcClock } from "@/components/maritime/format";
import { useNow } from "@/components/maritime/useNow";
import { VoyageBoard, type Lens } from "@/components/maritime/VoyageBoard";
import {
  listAllDocuments,
  listAllEvents,
  listAlerts,
  listShipments,
  listVesselPositionsByMmsi,
} from "@/lib/api";

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

  // The network in one line: where every voyage is.
  const network = useMemo(() => {
    const t = now ?? 0;
    let alongside = 0;
    let atSea = 0;
    let arrived = 0;
    let arriving72h = 0;
    for (const s of shipments) {
      if (s.actual_arrival || FINISHED.has(s.status)) arrived += 1;
      else if (s.actual_departure) atSea += 1;
      else alongside += 1;
      if (!s.actual_arrival && !FINISHED.has(s.status) && s.eta) {
        const eta = new Date(s.eta).getTime();
        if (eta > t && eta <= t + 3 * DAY) arriving72h += 1;
      }
    }
    return { alongside, atSea, arrived, arriving72h };
  }, [shipments, now]);

  const showOnBoard = (next: Lens) => {
    setLens(next);
    document.getElementById("board")?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  return (
    <AppShell title="Dashboard" bare>
      <div className="mx-auto w-full max-w-[1520px] px-4 pb-16 sm:px-6 lg:px-8">
        {/* The watch line: when, where the network stands, the one action */}
        <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 pb-6 pt-7">
          <div className="min-w-0">
            <h1 className="display text-[28px] leading-[32px] text-sea-ink">Dashboard</h1>
            <p className="mt-2 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[13px] text-sea-ink-3">
              {now != null ? (
                <span className="telemetry text-[11.5px] uppercase text-sea-ink-2">
                  {utcDate(now)} {utcClock(now)} UTC
                </span>
              ) : (
                <span className="inline-block h-3 w-36 animate-pulse rounded-sm bg-sea-paper-2" />
              )}
              {!isLoading && shipments.length > 0 ? (
                <span>
                  {shipments.length} voyage{shipments.length === 1 ? "" : "s"} on the book
                </span>
              ) : null}
              {!isLoading && network.arriving72h > 0 ? (
                <LensLink onClick={() => showOnBoard("arriving")}>
                  {network.arriving72h} arriving within 72h
                </LensLink>
              ) : null}
              {!isLoading && changedIds.size > 0 ? (
                <LensLink onClick={() => showOnBoard("changed")}>
                  {changedIds.size} ETA revised in 24h
                </LensLink>
              ) : null}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className={open ? btnGhost : btnPrimary}
          >
            {open ? (
              <X className="size-3.5" aria-hidden />
            ) : (
              <Plus className="size-3.5" aria-hidden />
            )}
            {open ? "Close form" : "New shipment"}
          </button>
        </header>

        {open ? (
          <div id="new-shipment" className="animate-in mb-6">
            <NewShipmentForm onClose={() => setOpen(false)} />
          </div>
        ) : null}

        {/* One grid, one gutter. Row one: the decisions and their context. */}
        <div className="grid gap-5 xl:grid-cols-12">
          <div className="min-w-0 xl:col-span-8">
            <AttentionQueue
              shipments={shipments}
              documents={documents}
              positions={positions}
              now={now}
              isLoading={isLoading}
              onFocus={setFocusId}
              onShowAll={() => showOnBoard("attention")}
            />
          </div>
          <div className="min-w-0 xl:col-span-4">
            <AtSea
              shipments={shipments}
              positions={positions}
              now={now}
              isLoading={isLoading}
              focusId={focusId}
              onFocus={setFocusId}
              onShowAll={() => showOnBoard("underway")}
            />
          </div>

          {/* Row two: the whole book */}
          <div className="min-w-0 xl:col-span-12">
            <VoyageBoard
              title="Shipment board"
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
              changedIds={changedIds}
              emptyTitle="No voyages on the board"
              emptyDescription="Create a shipment with its ports, vessel MMSI and planned dates. Its passage is plotted here and followed on AIS from departure."
              emptyAction={
                <button className={btnPrimary} onClick={() => setOpen(true)}>
                  <Plus className="size-3.5" aria-hidden /> New shipment
                </button>
              }
            />
          </div>

          {/* Row three: what comes next, and what has just changed */}
          <div className="min-w-0 lg:grid lg:grid-cols-2 lg:items-start lg:gap-5 xl:col-span-12 max-lg:space-y-5">
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
    </AppShell>
  );
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Wed 23 Sep" in UTC, matching the clock beside it. */
function utcDate(t: number) {
  const d = new Date(t);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** A figure in the watch line that filters the board below to itself. */
function LensLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="focus-ring rounded-sm font-medium text-ww-blue underline decoration-ww-blue-line underline-offset-[3px] transition-colors hover:text-ww-blue-hover hover:decoration-ww-blue"
    >
      {children}
    </button>
  );
}
