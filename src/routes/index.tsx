import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { AppShell, btnPrimary } from "@/components/AppShell";
import { NewShipmentForm } from "@/components/NewShipmentForm";
import { ShipmentTable } from "@/components/ShipmentTable";
import { SeverityBadge, SourceTag } from "@/components/StatusPill";
import { useMonitoringConfig } from "@/hooks/useMonitoringConfig";
import { isLegacyStatus, listAllDocuments, listAllEvents, listAlerts, listShipments } from "@/lib/api";
import { alertSeverity, kpis, relativeTime, SEVERITY_LABEL, type Severity } from "@/lib/lifecycle";

const SEVERITY_BORDER: Record<Severity, string> = {
  critical: "border-l-risk",
  attention: "border-l-warning",
  informational: "border-l-border",
};

const SOURCE_BORDER: Record<string, string> = {
  ais: "border-l-primary",
  system: "border-l-primary/50",
  manual: "border-l-border",
};

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

  return (
    <AppShell
      title={`${greeting()}, StimTech Solutions`}
      description={`Here's what's happening with your shipments today${
        lastSync ? ` · monitoring last checked ${relativeTime(lastSync)}` : ""
      }.`}
      actions={
        <button className={btnPrimary} onClick={() => setOpen((v) => !v)}>
          {open ? "Cancel" : "New Shipment"}
        </button>
      }
    >
      {open ? <NewShipmentForm onClose={() => setOpen(false)} /> : null}

      <div className="mb-8 flex flex-wrap items-start gap-x-10 gap-y-5">
        <Metric label="Active" value={stats.active} />
        <Divider />
        <Metric label="In Transit" value={stats.inTransit} />
        <Divider />
        <Metric label="Approaching" value={stats.approaching} />
        <Divider />
        <Metric label="Arrived" value={stats.arrived} />
        <Divider />
        <Metric label="Alerts" value={stats.exceptions} alert={stats.exceptions > 0} />
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

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section>
          <div className="mb-1.5 flex items-center justify-between">
            <h2 className="label-xs">Exceptions</h2>
            <Link to="/alerts" className="text-[11px] text-primary hover:underline">
              View all
            </Link>
          </div>
          <div className="panel overflow-hidden">
            {topAlerts.length === 0 ? (
              <p className="px-3 py-3 text-[12px] text-muted-foreground">No open alerts.</p>
            ) : (
              <ul>
                {topAlerts.map(({ alert, severity }) => {
                  const shipment = alert.shipment_id ? shipmentById.get(alert.shipment_id) : undefined;
                  const row = (
                    <div
                      className={`flex items-center gap-2.5 border-l-2 px-3 py-2 ${SEVERITY_BORDER[severity]}`}
                    >
                      <SeverityBadge severity={severity} label={SEVERITY_LABEL[severity]} />
                      <p className="min-w-0 flex-1 truncate text-[12px] text-foreground">{alert.message}</p>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {relativeTime(alert.created_at)}
                      </span>
                    </div>
                  );
                  return (
                    <li key={alert.id} className="border-b border-border last:border-0">
                      {shipment ? (
                        <Link
                          to="/shipments/$id"
                          params={{ id: shipment.id }}
                          className="block transition-colors hover:bg-tint-selected/30"
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
          </div>
        </section>

        <section>
          <h2 className="label-xs mb-1.5">Recent activity</h2>
          <div className="panel overflow-hidden">
            {events.length === 0 ? (
              <p className="px-3 py-3 text-[12px] text-muted-foreground">No recent activity yet.</p>
            ) : (
              <ul>
                {events.map((event) => {
                  const shipment = shipmentById.get(event.shipment_id);
                  const description =
                    event.field && (event.from_value || event.to_value)
                      ? `${event.field} → ${event.to_value ?? "—"}`
                      : (event.reason ?? event.event_type);
                  const content = (
                    <div
                      className={`flex items-center gap-2.5 border-l-2 px-3 py-2 ${SOURCE_BORDER[event.source] ?? "border-l-border"}`}
                    >
                      <p className="min-w-0 flex-1 truncate text-[12px] text-foreground">
                        {shipment ? shipment.client_name : "Shipment"}
                        <span className="text-muted-foreground"> — {description}</span>
                      </p>
                      <SourceTag source={event.source} automated={event.automated} />
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {relativeTime(event.occurred_at)}
                      </span>
                    </div>
                  );
                  return (
                    <li key={event.id} className="border-b border-border last:border-0">
                      {shipment ? (
                        <Link
                          to="/shipments/$id"
                          params={{ id: shipment.id }}
                          className="block transition-colors hover:bg-tint-selected/30"
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
          </div>
        </section>
      </div>
    </AppShell>
  );
}

/**
 * One cohesive line of operational numbers, not five separate cards.
 * Colour is used exactly once here — a small red dot when there are
 * genuinely open alerts — everything else is pure typography.
 */
function Metric({ label, value, alert }: { label: string; value: number; alert?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="label-xs">{label}</span>
      <span className="inline-flex items-center gap-2 text-[26px] leading-none font-semibold tracking-tight tabular-nums text-foreground">
        {alert ? <span aria-hidden className="size-[7px] rounded-full bg-risk" /> : null}
        {value}
      </span>
    </div>
  );
}

function Divider() {
  return <span aria-hidden className="hidden h-9 w-px bg-border sm:block" />;
}
