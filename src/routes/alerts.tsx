import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { AppShell } from "@/components/AppShell";
import { StatusPill, statusAccent } from "@/components/StatusPill";
import { listAlerts } from "@/lib/api";

const ACCENT_DOT: Record<string, string> = {
  neutral: "bg-muted-foreground/50",
  primary: "bg-primary",
  positive: "bg-positive",
  warning: "bg-warning",
};

export const Route = createFileRoute("/alerts")({
  head: () => ({
    meta: [
      { title: "Alerts Feed — StimTech Solutions" },
      {
        name: "description",
        content: "Chronological in-app feed of every shipment status change across your book.",
      },
      { property: "og:title", content: "Alerts Feed — StimTech Solutions" },
      {
        property: "og:description",
        content: "Every shipment status change, logged as it happens.",
      },
    ],
  }),
  component: AlertsPage,
});

function AlertsPage() {
  const { data: alerts = [], isLoading } = useQuery({ queryKey: ["alerts"], queryFn: listAlerts });

  return (
    <AppShell title="Alerts" description="Status changes are logged here as they happen.">
      <div className="panel divide-y divide-border">
        {isLoading ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">Loading feed…</p>
        ) : alerts.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">No activity yet.</p>
        ) : (
          alerts.map((a) => (
            <div
              key={a.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 transition-colors hover:bg-subtle/50"
            >
              <span
                aria-hidden
                className={`size-1.5 shrink-0 rounded-full ${
                  a.to_status ? ACCENT_DOT[statusAccent(a.to_status)] : "bg-muted-foreground/30"
                }`}
              />
              <span className="w-36 shrink-0 font-mono text-xs text-muted-foreground">
                {new Date(a.created_at).toLocaleString(undefined, {
                  month: "short",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
              <span className="flex-1 text-sm">
                {a.shipment_id ? (
                  <Link
                    to="/shipments/$id"
                    params={{ id: a.shipment_id }}
                    className="text-primary underline-offset-2 hover:underline"
                  >
                    {a.message}
                  </Link>
                ) : (
                  a.message
                )}
              </span>
              <span className="flex items-center gap-1.5">
                {a.from_status ? <StatusPill status={a.from_status} /> : null}
                {a.from_status && a.to_status ? <span className="text-xs text-muted-foreground">→</span> : null}
                {a.to_status ? <StatusPill status={a.to_status} /> : null}
              </span>
            </div>
          ))
        )}
      </div>
    </AppShell>
  );
}
