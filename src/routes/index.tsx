import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { AppShell, btnPrimary } from "@/components/AppShell";
import { NewShipmentForm } from "@/components/NewShipmentForm";
import { MonitoringBadge, StatusPill } from "@/components/StatusPill";
import { useLifecycleSync } from "@/hooks/useLifecycleSync";
import { useMonitoringConfig } from "@/hooks/useMonitoringConfig";
import { formatCost, listShipments, shortId } from "@/lib/api";
import { formatDayTime, monitoringInfo } from "@/lib/lifecycle";

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

function Dashboard() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const config = useMonitoringConfig();

  const { data: shipments = [], isLoading } = useQuery({
    queryKey: ["shipments"],
    queryFn: listShipments,
  });

  // Automated status pipeline: runs over loaded shipments, respects the
  // monitoring window and stops once a shipment is delivered.
  useLifecycleSync(shipments, config);

  return (
    <AppShell
      title="Shipments"
      description={`${shipments.length} shipment${shipments.length === 1 ? "" : "s"} on record`}
      actions={
        <button className={btnPrimary} onClick={() => setOpen((v) => !v)}>
          {open ? "Cancel" : "New Shipment"}
        </button>
      }
    >
      {open ? <NewShipmentForm onClose={() => setOpen(false)} /> : null}

      <div className="panel overflow-hidden">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-border bg-subtle">
              <Th>ID</Th>
              <Th>Client</Th>
              <Th>Route</Th>
              <Th>Planned ETD</Th>
              <Th>Current ETA</Th>
              <Th>Status</Th>
              <Th>Monitoring</Th>
              <Th className="text-right">Landed cost</Th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">
                  Loading shipments…
                </td>
              </tr>
            ) : shipments.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-10 text-center text-muted-foreground">
                  No shipments yet. Create your first one to get started.
                </td>
              </tr>
            ) : (
              shipments.map((s) => (
                <tr
                  key={s.id}
                  onClick={() => navigate({ to: "/shipments/$id", params: { id: s.id } })}
                  className="cursor-pointer border-b border-border last:border-0 transition-colors hover:bg-subtle"
                >
                  <td className="px-3 py-2 font-medium text-muted-foreground">{shortId(s.id)}</td>
                  <td className="px-3 py-2 font-medium">{s.client_name}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {s.origin} → {s.destination}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {formatDayTime(s.planned_etd)}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{formatDayTime(s.eta)}</td>
                  <td className="px-3 py-2">
                    <StatusPill status={s.status} />
                  </td>
                  <td className="px-3 py-2">
                    <MonitoringBadge state={monitoringInfo(s, config).state} />
                  </td>
                  <td className="px-3 py-2 text-right">{formatCost(s.landed_cost)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </AppShell>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={`px-3 py-2 text-left text-[11px] font-medium uppercase tracking-[0.04em] text-muted-foreground ${className}`}
    >
      {children}
    </th>
  );
}
