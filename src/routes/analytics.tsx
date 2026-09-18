import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { BarChart3 } from "lucide-react";

import { AppShell, EmptyState, Skeleton, Stat } from "@/components/AppShell";
import { StatusPill } from "@/components/StatusPill";
import { ACTIVE_STATUSES, formatCost, listAllDocuments, listShipments } from "@/lib/api";
import { kpis } from "@/lib/insights";

export const Route = createFileRoute("/analytics")({
  head: () => ({
    meta: [
      { title: "Analytics — StimTech Solutions" },
      {
        name: "description",
        content: "Portfolio-level shipment metrics: status mix, on-time rate and landed cost.",
      },
      { property: "og:title", content: "Analytics — StimTech Solutions" },
      {
        property: "og:description",
        content: "Status mix, on-time performance and landed cost by client.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AnalyticsPage,
});

function AnalyticsPage() {
  const { data: shipments = [], isLoading } = useQuery({
    queryKey: ["shipments"],
    queryFn: listShipments,
  });
  const { data: documents = [] } = useQuery({
    queryKey: ["all-documents"],
    queryFn: listAllDocuments,
  });

  const k = kpis(shipments, documents);

  const byClient = Object.entries(
    shipments.reduce<Record<string, { count: number; cost: number }>>((acc, s) => {
      const row = acc[s.client_name] ?? { count: 0, cost: 0 };
      row.count += 1;
      row.cost += s.landed_cost ?? 0;
      acc[s.client_name] = row;
      return acc;
    }, {}),
  ).sort((a, b) => b[1].cost - a[1].cost);

  const maxStatus = Math.max(
    1,
    ...ACTIVE_STATUSES.map((st) => shipments.filter((s) => s.status === st).length),
  );

  if (isLoading) {
    return (
      <AppShell eyebrow="Intelligence" title="Analytics">
        <div className="flex flex-wrap gap-x-10 gap-y-5 border-b border-border pb-6">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-14 w-28" />
          ))}
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell
      eyebrow="Intelligence"
      title="Analytics"
      description="Derived entirely from the shipments and documents stored in your workspace."
      wide
    >
      {shipments.length === 0 ? (
        <div className="panel">
          <EmptyState
            icon={BarChart3}
            title="Nothing to analyse yet"
            description="Metrics appear once your first shipment is created."
          />
        </div>
      ) : (
        <div className="flex flex-col gap-9">
          <div className="flex flex-wrap gap-x-10 gap-y-5 border-b border-border pb-6">
            <Stat label="Total Shipments" value={shipments.length} />
            <Stat label="Delivered" value={k.delivered} />
            <Stat label="On-Time Rate" value={`${k.onTimeRate}%`} />
            <Stat label="Total Landed Cost" value={formatCost(k.totalCost)} />
          </div>

          <div className="grid gap-8 lg:grid-cols-2">
            <section>
              <h2 className="label-xs mb-3">Status mix</h2>
              <ul className="space-y-2.5">
                {ACTIVE_STATUSES.map((st) => {
                  const count = shipments.filter((s) => s.status === st).length;
                  return (
                    <li key={st} className="flex items-center gap-3">
                      <span className="w-[150px] shrink-0">
                        <StatusPill status={st} />
                      </span>
                      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-subtle">
                        <span
                          className="block h-full rounded-full bg-primary/70"
                          style={{ width: `${(count / maxStatus) * 100}%` }}
                        />
                      </span>
                      <span className="w-6 text-right font-mono text-xs text-muted-foreground">{count}</span>
                    </li>
                  );
                })}
              </ul>
            </section>

            <section>
              <h2 className="label-xs mb-3">Landed cost by client</h2>
              <ul className="divide-y divide-border">
                {byClient.map(([client, row]) => (
                  <li
                    key={client}
                    className="flex items-center justify-between py-2 text-sm transition-colors hover:bg-subtle/50"
                  >
                    <span className="truncate font-medium">{client}</span>
                    <span className="ml-3 shrink-0 text-muted-foreground">
                      {row.count} · {formatCost(row.cost)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </div>
      )}
    </AppShell>
  );
}
