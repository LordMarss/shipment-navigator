import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Fragment } from "react";

import { AppShell } from "@/components/AppShell";
import { StatusPill } from "@/components/StatusPill";
import { clock, monthName, weekday } from "@/components/maritime/format";
import { ChartPanel, ConditionMark, Skeleton } from "@/components/maritime/marks";
import { Readouts } from "@/components/maritime/Readouts";
import { useNow } from "@/components/maritime/useNow";
import { listAlerts } from "@/lib/api";
import { alertSeverity, SEVERITY_LABEL } from "@/lib/lifecycle";

export const Route = createFileRoute("/alerts")({
  head: () => ({
    meta: [
      { title: "Alerts Feed - StimTech Solutions" },
      {
        name: "description",
        content: "Chronological in-app feed of every shipment status change across your book.",
      },
      { property: "og:title", content: "Alerts Feed - StimTech Solutions" },
      {
        property: "og:description",
        content: "Every shipment status change, logged as it happens.",
      },
    ],
  }),
  component: AlertsPage,
});

const DAY = 86_400_000;

/**
 * The alert log: every status change and alert, newest first, ruled off by
 * day like a logbook. Each entry carries its time, its condition mark
 * (alarm / caution / routine), the message and the phase transition.
 */
function AlertsPage() {
  const now = useNow();
  const { data: alerts = [], isLoading } = useQuery({ queryKey: ["alerts"], queryFn: listAlerts });
  const severities = alerts.map(alertSeverity);
  const critical = severities.filter((s) => s === "critical").length;
  const attention = severities.filter((s) => s === "attention").length;
  const last24 =
    now == null ? 0 : alerts.filter((a) => new Date(a.created_at).getTime() >= now - DAY).length;

  return (
    <AppShell
      title="Alerts"
      description="Status changes and alerts, entered as they happen."
      headerExtra={
        <Readouts
          loading={isLoading}
          items={[
            {
              label: "Critical",
              value: critical,
              ...(critical > 0
                ? { tone: "alarm" as const, mark: <ConditionMark level="alarm" size={7} /> }
                : {}),
            },
            {
              label: "Attention",
              value: attention,
              ...(attention > 0
                ? { tone: "caution" as const, mark: <ConditionMark level="caution" size={7} /> }
                : {}),
            },
            { label: "Last 24h", value: last24 },
            { label: "Entries", value: alerts.length },
          ]}
        />
      }
    >
      <ChartPanel
        id="alert-log"
        title="Entries"
        meta={isLoading ? null : `${alerts.length} logged`}
      >
        {isLoading ? (
          <div className="space-y-3 py-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
        ) : alerts.length === 0 ? (
          <p className="border-b border-sea-rule-2 py-6 text-[13px] text-sea-ink-3">
            Nothing logged yet. Status changes and alerts are entered here as they happen.
          </p>
        ) : (
          <ol>
            {alerts.map((a, i) => {
              const t = new Date(a.created_at).getTime();
              const day = new Date(t).toDateString();
              const prev = i > 0 ? new Date(alerts[i - 1]!.created_at).toDateString() : null;
              const severity = alertSeverity(a);
              const row = (
                <span className="grid grid-cols-[48px_16px_minmax(0,1fr)] items-baseline gap-x-3 md:grid-cols-[48px_16px_minmax(0,1fr)_auto]">
                  <time dateTime={a.created_at} className="telemetry text-[11.5px] text-sea-ink-2">
                    {clock(t)}
                  </time>
                  <span
                    className="flex translate-y-[1px] justify-center"
                    title={SEVERITY_LABEL[severity]}
                  >
                    {severity === "critical" ? (
                      <ConditionMark level="alarm" size={8} />
                    ) : severity === "attention" ? (
                      <ConditionMark level="caution" size={8} />
                    ) : (
                      <span
                        aria-hidden
                        className="inline-block size-[6px] border-[1.5px] border-sea-ink-4"
                      />
                    )}
                    <span className="sr-only">{SEVERITY_LABEL[severity]}</span>
                  </span>
                  <span className="text-[13.5px] leading-[1.45] text-sea-ink">{a.message}</span>
                  {a.from_status || a.to_status ? (
                    <span className="col-start-3 mt-1 flex flex-wrap items-center gap-2 text-[12px] md:col-start-auto md:mt-0 md:justify-end">
                      {a.from_status ? <StatusPill status={a.from_status} /> : null}
                      {a.from_status && a.to_status ? (
                        <span className="text-sea-ink-4">→</span>
                      ) : null}
                      {a.to_status ? <StatusPill status={a.to_status} /> : null}
                    </span>
                  ) : null}
                </span>
              );
              return (
                <Fragment key={a.id}>
                  {day !== prev ? (
                    <li className="label-xs border-b border-sea-rule pb-1.5 pt-5 first:pt-3">
                      {now != null && day === new Date(now).toDateString()
                        ? "Today"
                        : `${weekday(t)} ${new Date(t).getDate()} ${monthName(t)} ${new Date(t).getFullYear()}`}
                    </li>
                  ) : null}
                  <li className="border-b border-sea-rule-2">
                    {a.shipment_id ? (
                      <Link
                        to="/shipments/$id"
                        params={{ id: a.shipment_id }}
                        className="focus-ring block rounded-[1px] py-2.5 transition-colors hover:bg-sea-shallows/60"
                      >
                        {row}
                      </Link>
                    ) : (
                      <div className="py-2.5">{row}</div>
                    )}
                  </li>
                </Fragment>
              );
            })}
          </ol>
        )}
      </ChartPanel>
    </AppShell>
  );
}
