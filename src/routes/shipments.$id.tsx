import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { toast } from "sonner";

import { AppShell, btnDanger, btnGhost, btnPrimary, fieldClass } from "@/components/AppShell";
import { DocumentFiles } from "@/components/DocumentFiles";
import { ShipmentNotes } from "@/components/ShipmentNotes";
import { ShipmentTimeline } from "@/components/ShipmentTimeline";
import { StatusHistory } from "@/components/StatusHistory";
import { HealthBadge, MonitoringBadge, SeverityBadge, StatusPill } from "@/components/StatusPill";
import { useMonitoringConfig } from "@/hooks/useMonitoringConfig";
import {
  ACTIVE_STATUSES,
  advanceStatus,
  deleteShipment,
  formatCost,
  getShipment,
  getVesselPositionForShipment,
  listAlerts,
  listDocuments,
  listEvents,
  nextStatus,
  saveShipmentDetails,
  shortId,
  type ActiveShipmentStatus,
  type Shipment,
  type VesselPosition,
} from "@/lib/api";
import { deriveAutomation } from "@/lib/autoStatus";
import {
  alertSeverity,
  docsFor,
  formatDayTime,
  monitoringInfo,
  navStatusLabel,
  relativeTime,
  SEVERITY_LABEL,
  shipmentHealth,
} from "@/lib/lifecycle";

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

type TabKey = "overview" | "timeline" | "documents" | "notes" | "alerts";
const TABS: { key: TabKey; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "timeline", label: "Timeline" },
  { key: "documents", label: "Documents" },
  { key: "notes", label: "Notes" },
  { key: "alerts", label: "Alerts" },
];

function ShipmentDetail() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const config = useMonitoringConfig();
  const [tab, setTab] = useState<TabKey>("overview");

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
  const { data: alerts = [] } = useQuery({ queryKey: ["alerts"], queryFn: listAlerts });
  const { data: position } = useQuery({
    queryKey: ["vesselPosition", shipment?.vessel_mmsi ?? null],
    queryFn: () => getVesselPositionForShipment({ vessel_mmsi: shipment?.vessel_mmsi ?? null }),
    enabled: Boolean(shipment?.vessel_mmsi),
  });

  const [draft, setDraft] = useState<Shipment | null>(null);
  const [dates, setDates] = useState<DateDraft | null>(null);
  useEffect(() => {
    if (shipment) {
      setDraft(shipment);
      setDates(dateDraftFrom(shipment));
    }
  }, [shipment]);

  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideStatus, setOverrideStatus] = useState<ActiveShipmentStatus>("Scheduled");
  const [overrideReason, setOverrideReason] = useState("");

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

  const override = useMutation({
    mutationFn: async () => {
      if (!shipment) return;
      await saveShipmentDetails(shipment, { status: overrideStatus }, overrideReason.trim() || null);
    },
    onSuccess: () => {
      refresh();
      toast.success(`Status manually changed to ${overrideStatus}`);
      setOverrideOpen(false);
      setOverrideReason("");
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
  const shipmentAlerts = alerts.filter((a) => a.shipment_id === shipment.id);

  return (
    <AppShell
      title={shortId(shipment.id)}
      description={`${shipment.client_name} · ${shipment.origin} → ${shipment.destination}${
        shipment.vessel_name ? ` · ${shipment.vessel_name}` : ""
      }`}
      actions={
        <>
          <Link to="/" className={btnGhost}>
            Back to Shipments
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
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <StatusPill status={shipment.status} />
        <HealthBadge level={health.level} />
        <MonitoringBadge state={monitoring.state} />
        <span className="text-[12px] text-muted-foreground">{formatCost(shipment.landed_cost)} landed cost</span>
      </div>

      <div className="mb-4 flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`-mb-px border-b-2 px-3 py-2 text-[13px] font-medium transition-colors ${
              tab === t.key
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
            {t.key === "alerts" && shipmentAlerts.length > 0 ? ` (${shipmentAlerts.length})` : ""}
          </button>
        ))}
      </div>

      {tab === "overview" ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
          <div className="flex flex-col gap-4">
            <section className="panel p-4">
              <h2 className="mb-4 text-[13px] font-semibold">Shipment timeline</h2>
              <LifecycleStepper status={shipment.status} legacyTerminal={legacyTerminal} currentIndex={currentIndex} />
              <div className="mt-4 space-y-1 border-t border-border pt-3 text-[12px] text-muted-foreground">
                <p>Monitoring: {monitoring.reason}</p>
                <p>
                  Automation:{" "}
                  {decision.status === shipment.status ? "no pending change" : `will move to ${decision.status}`}
                  {" · "}
                  {decision.reason}
                </p>
              </div>
            </section>

            <section className="panel p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-[13px] font-semibold">Manual override</h2>
                {!overrideOpen ? (
                  <button
                    type="button"
                    className={btnGhost}
                    disabled={legacyTerminal}
                    onClick={() => {
                      setOverrideStatus((next ?? shipment.status) as ActiveShipmentStatus);
                      setOverrideOpen(true);
                    }}
                  >
                    Change status
                  </button>
                ) : null}
              </div>
              {legacyTerminal ? (
                <p className="text-[12px] text-muted-foreground">
                  This shipment holds a legacy status and has moved past the active lifecycle.
                </p>
              ) : !overrideOpen ? (
                <p className="text-[12px] text-muted-foreground">
                  Automation remains primary. Use this only to correct or fast-forward a shipment's
                  status outside the normal pipeline — every override is logged as a manual change.
                </p>
              ) : (
                <div className="space-y-3 rounded-sm border border-border bg-subtle/40 p-3">
                  <label className="block">
                    <span className="label-xs mb-1 block">New status</span>
                    <select
                      className={fieldClass}
                      value={overrideStatus}
                      onChange={(e) => setOverrideStatus(e.target.value as ActiveShipmentStatus)}
                    >
                      {ACTIVE_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="label-xs mb-1 block">Reason (optional)</span>
                    <textarea
                      className={`${fieldClass} min-h-[60px] resize-y`}
                      placeholder="Why is this being changed manually?"
                      value={overrideReason}
                      onChange={(e) => setOverrideReason(e.target.value)}
                    />
                  </label>
                  <div className="flex justify-end gap-1.5">
                    <button
                      type="button"
                      className={btnGhost}
                      onClick={() => {
                        setOverrideOpen(false);
                        setOverrideReason("");
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className={btnPrimary}
                      disabled={override.isPending || overrideStatus === shipment.status}
                      onClick={() => override.mutate()}
                    >
                      {override.isPending ? "Confirming…" : "Confirm change"}
                    </button>
                  </div>
                </div>
              )}
            </section>

            <form
              className="panel p-4"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate();
              }}
            >
              <h2 className="mb-3 text-[13px] font-semibold">Shipment information</h2>
              <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
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
              <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
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
                <InfoField
                  label="Last AIS update"
                  value={position ? relativeTime(position.position_timestamp ?? position.updated_at) : "No AIS data yet"}
                />
              </div>

              <div className="mt-4 flex items-center justify-between gap-2 border-t border-border pt-3">
                <button className={btnPrimary} type="submit" disabled={save.isPending}>
                  {save.isPending ? "Saving…" : "Save changes"}
                </button>
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
          </div>

          <VesselAisSection shipment={shipment} position={position} />
        </div>
      ) : null}

      {tab === "timeline" ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <ShipmentTimeline shipment={shipment} events={events} />
          <StatusHistory events={events} />
        </div>
      ) : null}

      {tab === "documents" ? <DocumentFiles shipmentId={id} documents={documents} /> : null}

      {tab === "notes" ? <ShipmentNotes shipmentId={id} /> : null}

      {tab === "alerts" ? (
        <div className="panel divide-y divide-border">
          {shipmentAlerts.length === 0 ? (
            <p className="px-3 py-8 text-center text-[13px] text-muted-foreground">
              No alerts recorded for this shipment.
            </p>
          ) : (
            shipmentAlerts.map((a) => {
              const severity = alertSeverity(a);
              return (
                <div key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
                  <SeverityBadge severity={severity} label={SEVERITY_LABEL[severity]} />
                  <span className="flex-1 text-[13px] text-foreground">{a.message}</span>
                  <span className="flex items-center gap-1.5">
                    {a.from_status ? <StatusPill status={a.from_status} /> : null}
                    {a.from_status && a.to_status ? (
                      <span className="text-[11px] text-muted-foreground">→</span>
                    ) : null}
                    {a.to_status ? <StatusPill status={a.to_status} /> : null}
                  </span>
                  <span className="w-32 shrink-0 text-right text-[11px] text-muted-foreground">
                    {formatDayTime(a.created_at)}
                  </span>
                </div>
              );
            })
          )}
        </div>
      ) : null}
    </AppShell>
  );
}

function LifecycleStepper({
  status,
  legacyTerminal,
  currentIndex,
}: {
  status: string;
  legacyTerminal: boolean;
  currentIndex: number;
}) {
  return (
    <div>
      <ol className="flex items-start">
        {ACTIVE_STATUSES.map((s, i) => {
          const done = legacyTerminal || i < currentIndex;
          const current = !legacyTerminal && i === currentIndex;
          const isFirst = i === 0;
          const isLast = i === ACTIVE_STATUSES.length - 1;
          return (
            <li key={s} className="flex flex-1 flex-col items-center">
              <div className="flex w-full items-center">
                <span className={`h-px flex-1 ${isFirst ? "opacity-0" : done || current ? "bg-primary" : "bg-border"}`} />
                <span
                  className={`flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold ${
                    current
                      ? "border-primary bg-primary text-primary-foreground"
                      : done
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-surface text-muted-foreground"
                  }`}
                >
                  {done ? <Check className="size-3" /> : i + 1}
                </span>
                <span className={`h-px flex-1 ${isLast ? "opacity-0" : done ? "bg-primary" : "bg-border"}`} />
              </div>
              <span
                className={`mt-1.5 text-center text-[11px] leading-tight ${
                  current ? "font-semibold text-foreground" : done ? "text-foreground" : "text-muted-foreground"
                }`}
              >
                {s}
              </span>
            </li>
          );
        })}
      </ol>
      {legacyTerminal ? (
        <p className="mt-3 text-[12px] text-muted-foreground">
          This shipment holds a legacy status ({status}), retired from the active lifecycle.
        </p>
      ) : null}
    </div>
  );
}

function VesselAisSection({
  shipment,
  position,
}: {
  shipment: Shipment;
  position: VesselPosition | null | undefined;
}) {
  return (
    <section className="panel h-fit p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[13px] font-semibold">Vessel · AIS</h2>
        <Link to="/map" className="text-[12px] text-primary hover:underline">
          Fleet map
        </Link>
      </div>

      {!shipment.vessel_mmsi ? (
        <p className="text-[12px] text-muted-foreground">No vessel assigned to this shipment yet.</p>
      ) : !position ? (
        <p className="text-[12px] text-muted-foreground">
          No AIS position received yet for MMSI {shipment.vessel_mmsi}.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-x-3 gap-y-3">
          <InfoField label="Vessel" value={position.vessel_name ?? shipment.vessel_name ?? "—"} />
          <InfoField label="MMSI" value={shipment.vessel_mmsi} />
          <InfoField label="Speed" value={position.sog != null ? `${position.sog.toFixed(1)} kn` : "—"} />
          <InfoField
            label="Heading"
            value={
              position.true_heading != null
                ? `${position.true_heading}°`
                : position.cog != null
                  ? `${position.cog}° (COG)`
                  : "—"
            }
          />
          <InfoField label="Nav status" value={navStatusLabel(position.nav_status)} />
          <InfoField
            label="Position"
            value={`${position.latitude.toFixed(3)}, ${position.longitude.toFixed(3)}`}
          />
          <InfoField
            label="AIS last updated"
            value={relativeTime(position.position_timestamp ?? position.updated_at)}
          />
        </div>
      )}
    </section>
  );
}

function InfoField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="label-xs mb-0.5 block">{label}</span>
      <span className="text-[13px] text-foreground">{value}</span>
    </div>
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
