import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { AlertTriangle, Anchor, CheckCircle2, Package, Ship } from "lucide-react";

import { AppShell, btnPrimary } from "@/components/AppShell";
import { NewShipmentForm } from "@/components/NewShipmentForm";
import { ShipmentTable } from "@/components/ShipmentTable";
import { SeverityBadge, SourceTag } from "@/components/StatusPill";
import { useMonitoringConfig } from "@/hooks/useMonitoringConfig";
import { isLegacyStatus, listAllDocuments, listAllEvents, listAlerts, listShipments } from "@/lib/api";
import { alertSeverity, kpis, relativeTime, SEVERITY_LABEL } from "@/lib/lifecycle";

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
    queryFn: () => listAllEvents(8),
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
    return scored.sort((a, b) => rank[a.severity] - rank[b.severity]).slice(0, 5);
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

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiCard label="Active Shipments" value={stats.active} icon={Package} />
        <KpiCard label="In Transit" value={stats.inTransit} icon={Ship} />
        <KpiCard label="Approaching Destination" value={stats.approaching} icon={Anchor} />
        <KpiCard label="Arrived" value={stats.arrived} icon={CheckCircle2} tone="positive" />
        <KpiCard
          label="Alerts / Exceptions"
          value={stats.exceptions}
          icon={AlertTriangle}
          tone={stats.exceptions > 0 ? "risk" : undefined}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="panel overflow-hidden">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="text-[13px] font-medium">Exceptions &amp; alerts</h2>
            <Link to="/alerts" className="text-[12px] text-primary hover:underline">
              View all
            </Link>
          </div>
          {topAlerts.length === 0 ? (
            <p className="px-4 py-6 text-[13px] text-muted-foreground">
              No open alerts. Everything is tracking as expected.
            </p>
          ) : (
            <ul>
              {topAlerts.map(({ alert, severity }) => {
                const shipment = alert.shipment_id ? shipmentById.get(alert.shipment_id) : undefined;
                const row = (
                  <div className="flex items-start gap-3 px-4 py-2.5">
                    <SeverityBadge severity={severity} label={SEVERITY_LABEL[severity]} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] text-foreground">{alert.message}</p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {shipment ? `${shipment.client_name} · ` : ""}
                        {relativeTime(alert.created_at)}
                      </p>
                    </div>
                  </div>
                );
                return (
                  <li key={alert.id} className="border-b border-border last:border-0">
                    {shipment ? (
                      <Link
                        to="/shipments/$id"
                        params={{ id: shipment.id }}
                        className="block transition-colors hover:bg-subtle/70"
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

        <section className="panel overflow-hidden">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="text-[13px] font-medium">Recent activity</h2>
          </div>
          {events.length === 0 ? (
            <p className="px-4 py-6 text-[13px] text-muted-foreground">No recent activity yet.</p>
          ) : (
            <ul>
              {events.map((event) => {
                const shipment = shipmentById.get(event.shipment_id);
                const description =
                  event.field && (event.from_value || event.to_value)
                    ? `${event.field} changed${event.from_value ? ` from ${event.from_value}` : ""} to ${event.to_value ?? "—"}`
                    : (event.reason ?? event.event_type);
                const content = (
                  <div className="px-4 py-2.5">
                    <p className="truncate text-[13px] text-foreground">
                      {shipment ? shipment.client_name : "Shipment"}
                      <span className="text-muted-foreground"> — {description}</span>
                    </p>
                    <div className="mt-0.5 flex items-center gap-2">
                      <SourceTag source={event.source} automated={event.automated} />
                      <span className="text-[11px] text-muted-foreground/70">
                        · {relativeTime(event.occurred_at)}
                      </span>
                    </div>
                  </div>
                );
                return (
                  <li key={event.id} className="border-b border-border last:border-0">
                    {shipment ? (
                      <Link
                        to="/shipments/$id"
                        params={{ id: shipment.id }}
                        className="block transition-colors hover:bg-subtle/70"
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

      <ShipmentTable shipments={shipments} documents={documents} alerts={alerts} isLoading={isLoading} />
    </AppShell>
  );
}

function KpiCard({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: number;
  icon: React.ComponentType<{ className?: string }>;
  tone?: "positive" | "risk" | undefined;
}) {
  const valueTone = tone === "positive" ? "text-positive" : tone === "risk" ? "text-risk" : "text-foreground";
  return (
    <div className="panel px-4 py-3.5">
      <div className="flex items-center justify-between">
        <span className="label-xs">{label}</span>
        <Icon className="size-3.5 text-muted-foreground/60" />
      </div>
      <p className={`mt-2 text-[26px] leading-none font-semibold tabular-nums ${valueTone}`}>{value}</p>
    </div>
  );
}
