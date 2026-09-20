import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { AppShell, btnPrimary } from "@/components/AppShell";
import { NewShipmentForm } from "@/components/NewShipmentForm";
import { ShipmentTable } from "@/components/ShipmentTable";
import { SeverityBadge, SourceTag } from "@/components/StatusPill";
import { useMonitoringConfig } from "@/hooks/useMonitoringConfig";
import {
  formatEta,
  isLegacyStatus,
  listAllDocuments,
  listAllEvents,
  listAlerts,
  listShipments,
  listVesselPositionsByMmsi,
  type Shipment,
} from "@/lib/api";
import { deriveVesselCondition } from "@/lib/aisAutomation";
import { alertSeverity, kpis, relativeTime, SEVERITY_LABEL, type Severity } from "@/lib/lifecycle";

const SEVERITY_ROW_BORDER: Record<Severity, string> = {
  critical: "border-l-risk",
  attention: "border-l-warning",
  informational: "border-l-transparent",
};

/** "in 3 days" / "tomorrow" / "today" — the future-facing counterpart to
 * `relativeTime`, which only ever looks backward. */
function daysUntil(iso: string) {
  const days = Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

function NextEvent({ label, shipment, date }: { label: string; shipment: Shipment; date: string }) {
  return (
    <Link to="/shipments/$id" params={{ id: shipment.id }} className="flex flex-col gap-1.5 hover:opacity-75">
      <span className="label-xs">{label}</span>
      <span className="text-sm">
        <span className="font-medium text-foreground">{shipment.client_name}</span>
        <span className="instrument text-muted-foreground">
          {" "}
          · {formatEta(date)} · {daysUntil(date)}
        </span>
      </span>
    </Link>
  );
}

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Shipment Dashboard — StimTech Solutions" },
      {
        name: "description",
        content:
          "Every shipment in one dense table: client, route, planned dates, pipeline status and landed cost.",
      },
      { property: "og:title", content: "Shipment Dashboard — StimTech Solutions" },
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

function greetingForHour(hour: number) {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** Time-of-day greeting, resolved only after mount. The server and the
 * browser can render on opposite sides of the "morning/afternoon/evening"
 * boundary a few milliseconds apart, which — if computed during the
 * initial render — produces a text mismatch between the server-rendered
 * HTML and the client's hydration pass. Resolving it in an effect keeps
 * the first render identical on both sides; the real greeting appears a
 * moment later, same as any other client-only value. */
function useGreeting() {
  const [greeting, setGreeting] = useState<string | null>(null);
  useEffect(() => {
    setGreeting(greetingForHour(new Date().getHours()));
  }, []);
  return greeting;
}

function Dashboard() {
  const [open, setOpen] = useState(false);
  const config = useMonitoringConfig();
  const greeting = useGreeting();

  const { data: shipments = [], isLoading } = useQuery({
    queryKey: ["shipments"],
    queryFn: listShipments,
  });
  const { data: documents = [] } = useQuery({
    queryKey: ["documents", "all"],
    queryFn: listAllDocuments,
  });
  const { data: alerts = [] } = useQuery({
    queryKey: ["alerts"],
    queryFn: listAlerts,
  });
  const { data: events = [] } = useQuery({
    queryKey: ["events", "recent"],
    queryFn: () => listAllEvents(6),
  });

  const mmsis = useMemo(
    () => shipments.map((s) => s.vessel_mmsi).filter((m): m is string => Boolean(m)),
    [shipments],
  );
  // Live telemetry for the whole fleet in one query — powers "Moving" below
  // and the inline speed reading in the table, refreshed on an interval so
  // a vessel that starts moving is reflected without a manual reload.
  const { data: positions } = useQuery({
    queryKey: ["vesselPositions", mmsis],
    queryFn: () => listVesselPositionsByMmsi(mmsis),
    enabled: mmsis.length > 0,
    refetchInterval: 45_000,
  });

  // The automated status pipeline runs server-side on a schedule, so nothing is
  // driven from the browser here. This only reports when it last ran.
  const lastSync = shipments
    .map((s) => s.last_synced_at)
    .filter((v): v is string => Boolean(v))
    .sort()
    .pop();

  const stats = useMemo(() => {
    const active = shipments.filter((s) => !isLegacyStatus(s.status) && s.status !== "Arrived").length;
    const { atRisk, delayed } = kpis(shipments, documents, config);
    return { active, exceptions: atRisk + delayed };
  }, [shipments, documents, config]);

  // "Moving" is read from real AIS telemetry, not the status field — a
  // shipment can say "In Transit" for days between position reports, but
  // this only counts a vessel confirmed underway right now.
  const moving = useMemo(() => {
    if (!positions) return [];
    return shipments.filter((s) => {
      if (!s.vessel_mmsi) return false;
      const position = positions.get(s.vessel_mmsi) ?? null;
      return deriveVesselCondition(s, position).kind === "underway";
    });
  }, [shipments, positions]);

  const arrivingSoon = useMemo(() => {
    const now = Date.now();
    const horizon = now + 3 * 86_400_000;
    return shipments.filter((s) => {
      if (s.status === "Arrived" || s.status === "Delivered" || !s.eta) return false;
      const t = new Date(s.eta).getTime();
      return t > now && t <= horizon;
    });
  }, [shipments]);

  // ETAs that were revised in the last 24 hours — read from the same alert
  // feed the Exceptions panel already uses, so this never disagrees with
  // what "an ETA changed" means elsewhere in the product.
  const changedShipmentIds = useMemo(() => {
    const cutoff = Date.now() - 24 * 3_600_000;
    const ids = new Set<string>();
    for (const a of alerts) {
      if (!a.shipment_id) continue;
      if (!a.message.toLowerCase().includes("eta changed")) continue;
      if (new Date(a.created_at).getTime() < cutoff) continue;
      ids.add(a.shipment_id);
    }
    return ids;
  }, [alerts]);

  const topAlerts = useMemo(() => {
    const scored = alerts.map((a) => ({ alert: a, severity: alertSeverity(a) }));
    const rank = { critical: 0, attention: 1, informational: 2 } as const;
    return scored.sort((a, b) => rank[a.severity] - rank[b.severity]).slice(0, 4);
  }, [alerts]);

  const shipmentById = useMemo(() => new Map(shipments.map((s) => [s.id, s])), [shipments]);

  const nextDeparture = useMemo(() => {
    const now = Date.now();
    return shipments
      .filter((s) => !s.actual_departure && s.planned_etd && new Date(s.planned_etd).getTime() > now)
      .sort((a, b) => new Date(a.planned_etd!).getTime() - new Date(b.planned_etd!).getTime())[0];
  }, [shipments]);

  const nextArrival = useMemo(() => {
    const now = Date.now();
    return shipments
      .filter(
        (s) =>
          s.status !== "Arrived" &&
          s.status !== "Delivered" &&
          s.eta &&
          new Date(s.eta).getTime() > now,
      )
      .sort((a, b) => new Date(a.eta!).getTime() - new Date(b.eta!).getTime())[0];
  }, [shipments]);

  return (
    <AppShell
      title={`${greeting ?? "Welcome"}, StimTech Solutions`}
      {...(lastSync ? { description: `Monitoring last checked ${relativeTime(lastSync)}.` } : {})}
      actions={
        <button className={btnPrimary} onClick={() => setOpen((v) => !v)}>
          {open ? "Cancel" : "New Shipment"}
        </button>
      }
      headerExtra={
        <div className="flex flex-col gap-7">
          {/* Leads with what needs attention, before the stats do. */}
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm">
            {stats.exceptions > 0 ? (
              <>
                <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-risk" />
                <span className="font-medium text-foreground">
                  {stats.exceptions} shipment{stats.exceptions === 1 ? "" : "s"} need attention
                </span>
                <Link to="/alerts" className="text-xs font-medium text-primary hover:underline">
                  Review →
                </Link>
              </>
            ) : (
              <>
                <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-positive" />
                <span className="text-muted-foreground">All shipments on track — nothing needs attention.</span>
              </>
            )}
          </div>

          <FleetStatusBand
            moving={moving.length}
            arriving={arrivingSoon.length}
            atRisk={stats.exceptions}
            changed={changedShipmentIds.size}
          />

          {moving.length > 0 && positions ? (
            <LiveFleetRail
              vessels={moving.map((s) => ({ shipment: s, position: positions.get(s.vessel_mmsi!)! }))}
            />
          ) : null}

          {nextDeparture || nextArrival ? (
            <div className="flex flex-wrap gap-x-12 gap-y-4 border-t border-border pt-6">
              {nextDeparture ? (
                <NextEvent label="Next departure" shipment={nextDeparture} date={nextDeparture.planned_etd!} />
              ) : null}
              {nextArrival ? (
                <NextEvent label="Next arrival" shipment={nextArrival} date={nextArrival.eta!} />
              ) : null}
            </div>
          ) : null}
        </div>
      }
    >
      {open ? <NewShipmentForm onClose={() => setOpen(false)} /> : null}

      <ShipmentTable
        shipments={shipments}
        documents={documents}
        alerts={alerts}
        positions={positions}
        isLoading={isLoading}
        showClient={false}
        showLandedCost={false}
        showLastUpdated
      />

      <div className="mt-9 grid gap-8 lg:grid-cols-2">
        <section className="min-w-0">
          <div className="mb-2.5 flex items-center justify-between">
            <h2 className="label-xs">Exceptions</h2>
            <Link to="/alerts" className="text-xs font-medium text-primary hover:underline">
              View all
            </Link>
          </div>
          {topAlerts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No open alerts.</p>
          ) : (
            <ul className="divide-y divide-border">
              {topAlerts.map(({ alert, severity }) => {
                const shipment = alert.shipment_id ? shipmentById.get(alert.shipment_id) : undefined;
                const row = (
                  <div className={`flex items-center gap-3 border-l-2 py-2.5 pl-3 ${SEVERITY_ROW_BORDER[severity]}`}>
                    <SeverityBadge severity={severity} label={SEVERITY_LABEL[severity]} />
                    <p className="min-w-0 flex-1 truncate text-sm text-foreground">{alert.message}</p>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {relativeTime(alert.created_at)}
                    </span>
                  </div>
                );
                return (
                  <li key={alert.id}>
                    {shipment ? (
                      <Link
                        to="/shipments/$id"
                        params={{ id: shipment.id }}
                        className="block transition-colors duration-150 hover:bg-atmosphere/60"
                      >
                        {row}
                      </Link>
                    ) : (
                      row
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="min-w-0">
          <h2 className="label-xs mb-2.5">Recent activity</h2>
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No recent activity yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {events.map((event) => {
                const shipment = shipmentById.get(event.shipment_id);
                const description =
                  event.field && (event.from_value || event.to_value)
                    ? `${event.field} → ${event.to_value ?? "—"}`
                    : (event.reason ?? event.event_type);
                const content = (
                  <div className="flex items-center gap-3 py-2.5">
                    <p className="min-w-0 flex-1 truncate text-sm text-foreground">
                      {shipment ? shipment.client_name : "Shipment"}
                      <span className="text-muted-foreground"> — {description}</span>
                    </p>
                    <SourceTag source={event.source} automated={event.automated} />
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {relativeTime(event.occurred_at)}
                    </span>
                  </div>
                );
                return (
                  <li key={event.id}>
                    {shipment ? (
                      <Link
                        to="/shipments/$id"
                        params={{ id: shipment.id }}
                        className="block transition-colors duration-150 hover:bg-atmosphere/60"
                      >
                        {content}
                      </Link>
                    ) : (
                      content
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </AppShell>
  );
}

const FLEET_STAT_TONE: Record<"primary" | "risk" | "warning" | "foreground" | "muted", string> = {
  primary: "text-primary-deep",
  risk: "text-risk",
  warning: "text-warning",
  foreground: "text-foreground",
  muted: "text-muted-foreground/55",
};

/**
 * The dashboard's command-centre strip: four operational readings a
 * shipping coordinator actually needs at a glance, replacing a flat count
 * of every lifecycle stage. Each block is quiet when its count is zero and
 * only picks up colour when there's something to act on — attention is
 * earned, not applied uniformly.
 */
function FleetStatusBand({
  moving,
  arriving,
  atRisk,
  changed,
}: {
  moving: number;
  arriving: number;
  atRisk: number;
  changed: number;
}) {
  return (
    <div className="flex flex-wrap items-stretch gap-x-8 gap-y-5">
      <FleetStatusItem label="Moving" hint="Underway now" value={moving} tone={moving > 0 ? "primary" : "muted"} live={moving > 0} />
      <span className="divider-fade hidden sm:block" aria-hidden />
      <FleetStatusItem label="Arriving soon" hint="Within 3 days" value={arriving} tone={arriving > 0 ? "foreground" : "muted"} />
      <span className="divider-fade hidden sm:block" aria-hidden />
      <FleetStatusItem label="At risk" hint="Health flagged" value={atRisk} tone={atRisk > 0 ? "risk" : "muted"} />
      <span className="divider-fade hidden sm:block" aria-hidden />
      <FleetStatusItem label="Changed today" hint="ETA revised" value={changed} tone={changed > 0 ? "warning" : "muted"} />
    </div>
  );
}

function FleetStatusItem({
  label,
  hint,
  value,
  tone,
  live = false,
}: {
  label: string;
  hint: string;
  value: number;
  tone: "primary" | "risk" | "warning" | "foreground" | "muted";
  live?: boolean;
}) {
  return (
    <div className="flex min-w-[108px] flex-col gap-1.5">
      <span className="label-xs inline-flex items-center gap-1.5">
        {live ? (
          <span aria-hidden className="ping-live relative inline-block size-1.5 shrink-0 rounded-full bg-primary text-primary" />
        ) : null}
        {label}
      </span>
      <span className={`instrument text-4xl font-semibold ${FLEET_STAT_TONE[tone]}`}>{value}</span>
      <span className="text-xs text-muted-foreground">{hint}</span>
    </div>
  );
}

/**
 * A live glimpse of the fleet, not just a count — every vessel AIS
 * confirms is underway right now, with its real speed. Renders nothing
 * when nothing is moving, so this row of the interface disappears the
 * moment it has nothing live to report rather than sitting there empty.
 */
function LiveFleetRail({
  vessels,
}: {
  vessels: { shipment: Shipment; position: { sog: number | null } }[];
}) {
  return (
    <div className="border-t border-border pt-6">
      <p className="label-xs mb-2.5">Underway right now</p>
      <div className="flex flex-wrap gap-2">
        {vessels.map(({ shipment, position }) => (
          <Link
            key={shipment.id}
            to="/shipments/$id"
            params={{ id: shipment.id }}
            className="chip transition-colors hover:border-primary/40"
          >
            <span aria-hidden className="ping-live relative inline-block size-1.5 shrink-0 rounded-full bg-primary text-primary" />
            <span className="font-medium text-foreground">{shipment.vessel_name ?? "Vessel"}</span>
            <span className="instrument text-muted-foreground">
              {position.sog != null ? `${position.sog.toFixed(1)} kn` : "—"}
            </span>
            <span className="text-muted-foreground/60">→ {shipment.destination}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
