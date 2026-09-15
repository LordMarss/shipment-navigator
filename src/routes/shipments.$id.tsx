import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { AppShell, btnDanger, btnGhost, btnPrimary, fieldClass } from "@/components/AppShell";
import { DocumentFiles } from "@/components/DocumentFiles";
import { ShipmentTimeline } from "@/components/ShipmentTimeline";
import { StatusHistory } from "@/components/StatusHistory";
import { HealthBadge, MonitoringBadge, StatusPill } from "@/components/StatusPill";
import { useMonitoringConfig } from "@/hooks/useMonitoringConfig";
import {
  ACTIVE_STATUSES,
  advanceStatus,
  deleteShipment,
  formatCost,
  getShipment,
  listDocuments,
  listEvents,
  nextStatus,
  saveShipmentDetails,
  shortId,
  type Shipment,
} from "@/lib/api";
import { deriveAutomation } from "@/lib/autoStatus";
import { docsFor, formatDayTime, monitoringInfo, shipmentHealth } from "@/lib/lifecycle";

export const Route = createFileRoute("/shipments/$id")({
  head: () => ({
    meta: [
      { title: "Shipment Detail — StimTech Solutions" },
      {
        name: "description",
        content:
          "Edit shipment schedule and details, follow the automated status pipeline and tick off required trade documents.",
      },
      { property: "og:title", content: "Shipment Detail — StimTech Solutions" },
      {
        property: "og:description",
        content:
          "Planned, current and actual dates, automated status pipeline, document checklist and audit trail.",
      },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ShipmentDetail,
});

/** ISO timestamp → datetime-local input value in the viewer's timezone. */
function toLocalInput(value: string | null | undefined) {
  if (!value) return "";
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toIso(value: string) {
  return value ? new Date(value).toISOString() : null;
}

type DateDraft = {
  planned_etd: string;
  planned_eta: string;
  eta: string;
  actual_departure: string;
  actual_arrival: string;
  actual_delivery: string;
};

function dateDraftFrom(s: Shipment): DateDraft {
  return {
    planned_etd: toLocalInput(s.planned_etd),
    planned_eta: toLocalInput(s.planned_eta),
    eta: toLocalInput(s.eta),
    actual_departure: toLocalInput(s.actual_departure),
    actual_arrival: toLocalInput(s.actual_arrival),
    actual_delivery: toLocalInput(s.actual_delivery),
  };
}

function ShipmentDetail() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const config = useMonitoringConfig();

  const { data: shipment, isLoading } = useQuery({
    queryKey: ["shipment", id],
    queryFn: () => getShipment(id),
  });
  const { data: documents = [] } = useQuery({
    queryKey: ["documents", id],
    queryFn: () => listDocuments(id),
  });
  const { data: events = [] } = useQuery({
    queryKey: ["events", id],
    queryFn: () => listEvents(id),
  });



  const [draft, setDraft] = useState<Shipment | null>(null);
  const [dates, setDates] = useState<DateDraft | null>(null);
  useEffect(() => {
    if (shipment) {
      setDraft(shipment);
      setDates(dateDraftFrom(shipment));
    }
  }, [shipment]);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["shipment", id] });
    queryClient.invalidateQueries({ queryKey: ["events", id] });
    queryClient.invalidateQueries({ queryKey: ["shipments"] });
    queryClient.invalidateQueries({ queryKey: ["alerts"] });
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!draft || !dates || !shipment) return;
      await saveShipmentDetails(shipment, {
        client_name: draft.client_name,
        origin: draft.origin,
        destination: draft.destination,
        vessel_name: draft.vessel_name || null,
        vessel_mmsi: draft.vessel_mmsi || null,
        landed_cost: draft.landed_cost == null ? null : Number(draft.landed_cost),
        planned_etd: toIso(dates.planned_etd),
        planned_eta: toIso(dates.planned_eta),
        eta: toIso(dates.eta),
        actual_departure: toIso(dates.actual_departure),
        actual_arrival: toIso(dates.actual_arrival),
        actual_delivery: toIso(dates.actual_delivery),
      });
    },
    onSuccess: () => {
      refresh();
      toast.success("Shipment updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const advance = useMutation({
    mutationFn: async () => {
      if (shipment) await advanceStatus(shipment);
    },
    onSuccess: () => {
      refresh();
      toast.success("Status advanced");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: () => deleteShipment(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["shipments"] });
      queryClient.invalidateQueries({ queryKey: ["alerts"] });
      toast.success("Shipment deleted");
      navigate({ to: "/" });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) {
    return (
      <AppShell title="Shipment">
        <p className="panel px-3 py-8 text-center text-[13px] text-muted-foreground">Loading…</p>
      </AppShell>
    );
  }

  if (!shipment || !draft || !dates) {
    return (
      <AppShell title="Shipment not found">
        <div className="panel px-3 py-8 text-center text-[13px] text-muted-foreground">
          This shipment no longer exists.{" "}
          <Link to="/" className="text-primary hover:underline">
            Back to dashboard
          </Link>
        </div>
      </AppShell>
    );
  }

  const currentIndex = ACTIVE_STATUSES.indexOf(shipment.status as (typeof ACTIVE_STATUSES)[number]);
  // A shipment holding a status retired from the active lifecycle (legacy
  // At Port / Cleared Customs / Delivered records) has moved past every step
  // this pipeline tracks.
  const legacyTerminal = currentIndex === -1;
  const next = nextStatus(shipment.status);
  const monitoring = monitoringInfo(shipment, config);
  const health = shipmentHealth(shipment, docsFor(documents, shipment.id), config);
  const decision = deriveAutomation(shipment, config);

  return (
    <AppShell
      title={`${shortId(shipment.id)} · ${shipment.client_name}`}
      description={`${shipment.origin} → ${shipment.destination} · ${formatCost(shipment.landed_cost)} landed cost`}
      actions={
        <>
          <Link to="/" className={btnGhost}>
            Back
          </Link>
          <button
            className={btnPrimary}
            disabled={!next || advance.isPending}
            onClick={() => advance.mutate()}
          >
            {next ? `Advance to ${next}` : shipment.status}
          </button>
        </>
      }
    >
      <div className="panel mb-4 p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="text-[13px] font-semibold">Status pipeline</h2>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <StatusPill status={shipment.status} />
            <HealthBadge level={health.level} />
            <MonitoringBadge state={monitoring.state} />
          </div>
        </div>
        <ol className="flex flex-wrap items-stretch gap-1.5">
          {ACTIVE_STATUSES.map((s, i) => {
            const active = !legacyTerminal && i === currentIndex;
            const past = legacyTerminal || i < currentIndex;
            return (
              <li
                key={s}
                className={`flex-1 min-w-[120px] rounded-sm border px-2.5 py-2 text-[12px] ${
                  active
                    ? "border-primary bg-primary text-primary-foreground font-semibold"
                    : past
                      ? "border-border bg-subtle text-foreground font-medium"
                      : "border-border bg-surface text-muted-foreground"
                }`}
              >
                <span className="block text-[10px] opacity-70">Stage {i + 1}</span>
                {s}
              </li>
            );
          })}
        </ol>
        <div className="mt-3 space-y-1 border-t border-border pt-3 text-[12px] text-muted-foreground">
          <p>Monitoring: {monitoring.reason}</p>
          <p>
            Automation: {decision.status === shipment.status ? "no pending change" : `will move to ${decision.status}`}
            {" · "}
            {decision.reason}
          </p>
          <p>
            Last synced {formatDayTime(shipment.last_synced_at)} · last updated{" "}
            {formatDayTime(shipment.updated_at)} · created {formatDayTime(shipment.created_at)}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
        <form
          className="panel p-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <h2 className="mb-3 text-[13px] font-semibold">Shipment info</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Client">
              <input
                className={fieldClass}
                value={draft.client_name}
                onChange={(e) => setDraft({ ...draft, client_name: e.target.value })}
              />
            </Field>
            <Field label="Landed cost (USD)">
              <input
                className={fieldClass}
                type="number"
                step="0.01"
                value={draft.landed_cost ?? ""}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    landed_cost: e.target.value === "" ? null : Number(e.target.value),
                  })
                }
              />
            </Field>
            <Field label="Origin">
              <input
                className={fieldClass}
                value={draft.origin}
                onChange={(e) => setDraft({ ...draft, origin: e.target.value })}
              />
            </Field>
            <Field label="Destination">
              <input
                className={fieldClass}
                value={draft.destination}
                onChange={(e) => setDraft({ ...draft, destination: e.target.value })}
              />
            </Field>
            <Field label="Vessel name">
              <input
                className={fieldClass}
                value={draft.vessel_name ?? ""}
                onChange={(e) => setDraft({ ...draft, vessel_name: e.target.value })}
              />
            </Field>
            <Field label="Vessel MMSI">
              <input
                className={fieldClass}
                value={draft.vessel_mmsi ?? ""}
                onChange={(e) => setDraft({ ...draft, vessel_mmsi: e.target.value })}
              />
            </Field>
          </div>

          <h3 className="mt-4 border-t border-border pt-3 text-[13px] font-semibold">Schedule</h3>
          <p className="mb-3 text-[12px] text-muted-foreground">
            Planned, current and actual times are stored separately, so automation never overwrites
            the original plan.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Planned departure (ETD)">
              <input
                className={fieldClass}
                type="datetime-local"
                value={dates.planned_etd}
                onChange={(e) => setDates({ ...dates, planned_etd: e.target.value })}
              />
            </Field>
            <Field label="Planned arrival (ETA)">
              <input
                className={fieldClass}
                type="datetime-local"
                value={dates.planned_eta}
                onChange={(e) => setDates({ ...dates, planned_eta: e.target.value })}
              />
            </Field>
            <Field label="Current ETA">
              <input
                className={fieldClass}
                type="datetime-local"
                value={dates.eta}
                onChange={(e) => setDates({ ...dates, eta: e.target.value })}
              />
            </Field>
            <Field label="Actual departure">
              <input
                className={fieldClass}
                type="datetime-local"
                value={dates.actual_departure}
                onChange={(e) => setDates({ ...dates, actual_departure: e.target.value })}
              />
            </Field>
            <Field label="Actual arrival">
              <input
                className={fieldClass}
                type="datetime-local"
                value={dates.actual_arrival}
                onChange={(e) => setDates({ ...dates, actual_arrival: e.target.value })}
              />
            </Field>
            <Field label="Actual delivery">
              <input
                className={fieldClass}
                type="datetime-local"
                value={dates.actual_delivery}
                onChange={(e) => setDates({ ...dates, actual_delivery: e.target.value })}
              />
            </Field>
          </div>

          <div className="mt-4 flex items-center justify-between gap-2 border-t border-border pt-3">
            <div className="flex items-center gap-2">
              <button className={btnPrimary} type="submit" disabled={save.isPending}>
                {save.isPending ? "Saving…" : "Save changes"}
              </button>
              <Link to="/map" className={btnGhost}>
                Fleet map
              </Link>
            </div>
            <button
              type="button"
              className={btnDanger}
              onClick={() => {
                if (confirm("Delete this shipment and its documents?")) remove.mutate();
              }}
            >
              Delete
            </button>
          </div>
        </form>

        <DocumentFiles shipmentId={id} documents={documents} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ShipmentTimeline shipment={shipment} events={events} />
        <StatusHistory events={events} />
      </div>
    </AppShell>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="label-xs mb-1 block">{label}</span>
      {children}
    </label>
  );
}
