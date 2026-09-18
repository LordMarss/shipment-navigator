import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { AppShell, Stat, btnPrimary } from "@/components/AppShell";
import { NewShipmentForm } from "@/components/NewShipmentForm";
import { ShipmentTable } from "@/components/ShipmentTable";
import { SeverityBadge, SourceTag } from "@/components/StatusPill";
import { useMonitoringConfig } from "@/hooks/useMonitoringConfig";
import { isLegacyStatus, listAllDocuments, listAllEvents, listAlerts, listShipments } from "@/lib/api";
import { alertSeverity, kpis, relativeTime, SEVERITY_LABEL, type Severity } from "@/lib/lifecycle";

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

function greeting(date = new Date()) {
  const hour = date.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function Dashboard() {
  const [open, setOpen] = useState(false);
  const config = useMonitoringConfig();

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

  // The automated status pipeline runs server-side on a schedule, so nothing is
  // driven from the browser here. This only reports when it last ran.
  const lastSync = shipments
    .map((s) => s.last_synced_at)
    .filter((v): v is string => Boolean(v))
    .sort()
    .pop();

  const stats = useMemo(() => {
    const countByStatus = (status: string) => shipments.filter((s) => s.status === status).length;
    const active = shipments.filter((s) => !isLegacyStatus(s.status) && s.status !== "Arrived").length;
    const { atRisk, delayed } = kpis(shipments, documents, config);
    return {
      active,
      inTransit: countByStatus("In Transit"),
      approaching: countByStatus("Approaching Destination"),
      arrived: countByStatus("Arrived"),
      exceptions: atRisk + delayed,
    };
  }, [shipments, documents, config]);

  const topAlerts = useMemo(() => {
    const scored = alerts.map((a) => ({ alert: a, severity: alertSeverity(a) }));
    const rank = { critical: 0, attention: 1, informational: 2 } as const;
    return scored.sort((a, b) => rank[a.severity] - rank[b.severity]).slice(0, 4);
  }, [alerts]);

  const shipmentById = useMemo(() => new Map(shipments.map((s) => [s.id, s])), [shipments]);

  // A clean, mutually-exclusive partition of every shipment for the mix
  // bar below — not the overlapping "active" bucket used for the number,
  // so the segments always sum to the full shipment count.
  const mix = useMemo(() => {
    const other = Math.max(0, shipments.length - stats.inTransit - stats.approaching - stats.arrived);
    return { other, inTransit: stats.inTransit, approaching: stats.approaching, arrived: stats.arrived };
  }, [shipments.length, stats]);
  const mixTotal = shipments.length || 1;

  return (
    <AppShell
      title={`${greeting()}, StimTech Solutions`}
      {...(lastSync ? { description: `Monitoring last checked ${relativeTime(lastSync)}.` } : {})}
      actions={
        <button className={btnPrimary} onClick={() => setOpen((v) => !v)}>
          {open ? "Cancel" : "New Shipment"}
        </button>
      }
    >
      {open ? <NewShipmentForm onClose={() => setOpen(false)} /> : null}

      {/* Leads with what needs attention, before the stats do. */}
      <div className="mb-6 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm">
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

      <div className="mb-8 border-b border-border pb-6">
        <div className="flex flex-wrap items-start gap-x-10 gap-y-5">
          <Stat label="Active" value={stats.active} />
          <Stat label="In Transit" value={stats.inTransit} />
          <Stat label="Approaching" value={stats.approaching} />
          <Stat label="Arrived" value={stats.arrived} />
        </div>
        {shipments.length > 0 ? (
          <div className="mt-5 flex h-[3px] w-full overflow-hidden rounded-full bg-subtle" aria-hidden>
            {mix.other > 0 ? (
              <span className="bg-muted-foreground/25" style={{ width: `${(mix.other / mixTotal) * 100}%` }} />
            ) : null}
            {mix.inTransit > 0 ? (
              <span className="bg-primary" style={{ width: `${(mix.inTransit / mixTotal) * 100}%` }} />
            ) : null}
            {mix.approaching > 0 ? (
              <span className="bg-warning" style={{ width: `${(mix.approaching / mixTotal) * 100}%` }} />
            ) : null}
            {mix.arrived > 0 ? (
              <span className="bg-positive" style={{ width: `${(mix.arrived / mixTotal) * 100}%` }} />
            ) : null}
          </div>
        ) : null}
      </div>

      <ShipmentTable
        shipments={shipments}
        documents={documents}
        alerts={alerts}
        isLoading={isLoading}
        showClient={false}
        showLandedCost={false}
        showLastUpdated
      />

      <div className="mt-9 grid gap-8 lg:grid-cols-2">
        <section>
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
                  <div className="flex items-center gap-3 py-2.5">
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
                        className="block transition-colors duration-150 hover:bg-subtle/60"
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

        <section>
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
                        className="block transition-colors duration-150 hover:bg-subtle/60"
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
