import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { Ship } from "lucide-react";

import { AppShell, EmptyState, Skeleton } from "@/components/AppShell";
import { StatusPill } from "@/components/StatusPill";
import { formatEta, listShipments, shortId } from "@/lib/api";

export const Route = createFileRoute("/vessels")({
  head: () => ({
    meta: [
      { title: "Vessels — StimTech Solutions" },
      {
        name: "description",
        content: "Every vessel carrying one of your shipments, with MMSI, route and ETA.",
      },
      { property: "og:title", content: "Vessels — StimTech Solutions" },
      {
        property: "og:description",
        content: "Vessels tracked across your active and completed shipments.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: VesselsPage,
});

function VesselsPage() {
  const { data: shipments = [], isLoading } = useQuery({
    queryKey: ["shipments"],
    queryFn: listShipments,
  });

  const withVessel = shipments.filter((s) => s.vessel_name || s.vessel_mmsi);

  return (
    <AppShell
      eyebrow="Fleet"
      title="Vessels"
      description="Vessels resolved from the MMSI recorded on your shipments."
      wide
    >
      {isLoading ? (
        <div className="panel space-y-2 p-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : withVessel.length === 0 ? (
        <div className="panel">
          <EmptyState
            icon={Ship}
            title="No vessels yet"
            description="Add a vessel name or MMSI to a shipment and it will appear here."
          />
        </div>
      ) : (
        <div className="panel overflow-x-auto">
          <table className="w-full min-w-[820px] border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="label-xs px-3 py-2">Vessel</th>
                <th className="label-xs px-3 py-2">MMSI</th>
                <th className="label-xs px-3 py-2">Shipment</th>
                <th className="label-xs px-3 py-2">Route</th>
                <th className="label-xs px-3 py-2">ETA</th>
                <th className="label-xs px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {withVessel.map((s) => (
                <tr key={s.id} className="transition-colors hover:bg-tint-selected/30">
                  <td className="px-3 py-2 font-medium">{s.vessel_name || "Unnamed vessel"}</td>
                  <td className="px-3 py-2 font-mono text-[12px] text-muted-foreground">
                    {s.vessel_mmsi || "—"}
                  </td>
                  <td className="px-3 py-2">
                    <Link
                      to="/shipments/$id"
                      params={{ id: s.id }}
                      className="font-mono text-[12px] text-primary hover:underline"
                    >
                      {shortId(s.id)}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {s.origin} → {s.destination}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{formatEta(s.eta)}</td>
                  <td className="px-3 py-2">
                    <StatusPill status={s.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AppShell>
  );
}
