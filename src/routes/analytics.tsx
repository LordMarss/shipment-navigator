import { createFileRoute } from "@tanstack/react-router";

import { AppShell } from "@/components/AppShell";
import { StatusPill, statusAccent, type StatusAccent } from "@/components/StatusPill";
import { ChartPanel, ConditionMark, Skeleton } from "@/components/maritime/marks";
import { Readouts } from "@/components/maritime/Readouts";
import { useFleet } from "@/components/maritime/useFleet";
import { ACTIVE_STATUSES, formatCost } from "@/lib/api";
import { kpis } from "@/lib/lifecycle";

export const Route = createFileRoute("/analytics")({
  head: () => ({
    meta: [
      { title: "Analytics - StimTech Solutions" },
      {
        name: "description",
        content: "Portfolio-level shipment metrics: status mix, on-time rate and landed cost.",
      },
      { property: "og:title", content: "Analytics - StimTech Solutions" },
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

const FILL: Record<StatusAccent, string> = {
  neutral: "bg-sea-ink-3",
  primary: "bg-sea-move",
  positive: "bg-sea-green",
  warning: "bg-sea-amber",
};
const STACK_MAX = 12;

/**
 * Fleet analytics, read like a passage plan: the lifecycle as stations
 * along a line with the shipments standing at each, and landed cost by
 * client as a ruled register. Same derivations as before (kpis and a
 * per-client roll-up of stored shipments).
 */
function AnalyticsPage() {
  const { shipments, documents, isLoading } = useFleet();
  const k = kpis(shipments, documents);
  const alarm = k.atRisk + k.delayed;

  const byClient = Object.entries(
    shipments.reduce<Record<string, { count: number; cost: number }>>((acc, s) => {
      const row = acc[s.client_name] ?? { count: 0, cost: 0 };
      row.count += 1;
      row.cost += s.landed_cost ?? 0;
      acc[s.client_name] = row;
      return acc;
    }, {}),
  ).sort((a, b) => b[1].cost - a[1].cost);
  const maxCost = Math.max(1, ...byClient.map(([, r]) => r.cost));
  const phases = ACTIVE_STATUSES.map((st) => ({
    st,
    count: shipments.filter((s) => s.status === st).length,
  }));

  return (
    <AppShell
      eyebrow="Intelligence"
      title="Analytics"
      description="Derived entirely from the shipments and documents stored in your workspace."
      wide
      headerExtra={
        <Readouts
          loading={isLoading}
          items={[
            { label: "Shipments", value: shipments.length },
            { label: "Active", value: k.active },
            { label: "Delivered", value: k.delivered },
            { label: "On time", value: `${k.onTimeRate}%` },
            {
              label: "In alarm",
              value: alarm,
              ...(alarm > 0
                ? { tone: "alarm" as const, mark: <ConditionMark level="alarm" size={7} /> }
                : {}),
            },
            { label: "Landed cost", value: formatCost(k.totalCost) },
          ]}
        />
      }
    >
      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : shipments.length === 0 ? (
        <div className="border-y border-sea-rule-2 py-10">
          <p className="text-[14px] font-medium text-sea-ink">Nothing to analyse yet</p>
          <p className="mt-1 text-[13px] text-sea-ink-2">
            Metrics appear once your first shipment is created.
          </p>
        </div>
      ) : (
        <div className="grid gap-x-12 gap-y-12 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
          <ChartPanel id="phases" title="Fleet by phase" meta="shipments at each station">
            {/* Stations along the passage, each stacking one cell per shipment */}
            <div className="relative mt-6 px-2">
              <div
                className="grid items-end gap-2"
                style={{ gridTemplateColumns: `repeat(${phases.length}, minmax(0, 1fr))` }}
              >
                {phases.map(({ st, count }) => (
                  <div
                    key={st}
                    className="flex min-h-[112px] flex-col items-center justify-end gap-[3px]"
                  >
                    <span className="telemetry mb-1 text-[13px] text-sea-ink">{count}</span>
                    {Array.from({ length: Math.min(count, STACK_MAX) }).map((_, i) => (
                      <span
                        key={i}
                        aria-hidden
                        className={`h-[6px] w-5 ${FILL[statusAccent(st)]}`}
                      />
                    ))}
                    {count > STACK_MAX ? (
                      <span className="telemetry text-[10px] text-sea-ink-3">
                        +{count - STACK_MAX}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
              <div className="relative mt-3 h-[12px]">
                <span className="absolute inset-x-[6%] top-1/2 -translate-y-1/2 border-t border-dashed border-sea-ink-4" />
                <div
                  className="absolute inset-0 grid"
                  style={{ gridTemplateColumns: `repeat(${phases.length}, minmax(0, 1fr))` }}
                >
                  {phases.map(({ st }) => (
                    <span key={st} className="flex items-center justify-center">
                      <span className="size-[9px] rounded-full border-[1.5px] border-sea-ink-2 bg-sea-paper" />
                    </span>
                  ))}
                </div>
              </div>
              <div
                className="mt-2 grid gap-2"
                style={{ gridTemplateColumns: `repeat(${phases.length}, minmax(0, 1fr))` }}
              >
                {phases.map(({ st }) => (
                  <span key={st} className="label-xs text-center !text-[9.5px] leading-tight">
                    {st === "Approaching Destination" ? "Approaching" : st}
                  </span>
                ))}
              </div>
            </div>
            <ul className="mt-6 grid grid-cols-2 gap-x-8 border-t border-sea-rule-2 pt-3 sm:grid-cols-3">
              {phases.map(({ st, count }) => (
                <li key={st} className="flex items-baseline justify-between py-1 text-[12.5px]">
                  <StatusPill status={st} />
                  <span className="telemetry text-[12px] text-sea-ink-2">{count}</span>
                </li>
              ))}
            </ul>
          </ChartPanel>

          <ChartPanel
            id="clients"
            title="Landed cost by client"
            meta={`${byClient.length} clients`}
          >
            <table className="w-full table-fixed border-collapse text-left">
              <thead>
                <tr className="shadow-[inset_0_-1px_0_var(--sea-rule)]">
                  <th scope="col" className="label-xs py-2 pr-4 font-normal">
                    Client
                  </th>
                  <th scope="col" className="label-xs w-[72px] py-2 pr-4 text-right font-normal">
                    Voyages
                  </th>
                  <th scope="col" className="label-xs w-[104px] py-2 text-right font-normal">
                    Landed cost
                  </th>
                </tr>
              </thead>
              <tbody>
                {byClient.map(([client, row]) => (
                  <tr key={client} className="border-b border-sea-rule-2">
                    <td className="py-2.5 pr-4">
                      <span className="block truncate text-[13.5px] text-sea-ink">{client}</span>
                      <span
                        aria-hidden
                        className="mt-1.5 block h-[3px] bg-sea-ink-3"
                        style={{ width: `${(row.cost / maxCost) * 100}%` }}
                      />
                    </td>
                    <td className="telemetry py-2.5 pr-4 text-right text-[12px] text-sea-ink-2">
                      {row.count}
                    </td>
                    <td className="telemetry py-2.5 text-right text-[12.5px] text-sea-ink">
                      {formatCost(row.cost)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ChartPanel>
        </div>
      )}
    </AppShell>
  );
}
