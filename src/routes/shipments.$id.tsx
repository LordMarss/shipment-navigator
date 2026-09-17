import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronRight,
  MapPin,
  MoreHorizontal,
  RotateCcw,
  Ship,
} from "lucide-react";
import { toast } from "sonner";

import { AppShell, btnGhost, btnPrimary, fieldClass } from "@/components/AppShell";
import { DocumentFiles } from "@/components/DocumentFiles";
import { PortAutocomplete } from "@/components/PortAutocomplete";
import { ShipmentNotes } from "@/components/ShipmentNotes";
import { ShipmentTimeline } from "@/components/ShipmentTimeline";
import { StatusHistory } from "@/components/StatusHistory";
import { SeverityBadge, StatusPill, VesselConditionBadge } from "@/components/StatusPill";
import { useMonitoringConfig } from "@/hooks/useMonitoringConfig";
import {
  ACTIVE_STATUSES,
  advanceStatus,
  deleteShipment,
  getShipment,
  getVesselPositionForShipment,
  listAlerts,
  listDocuments,
  listEvents,
  listPorts,
  nextStatus,
  saveShipmentDetails,
  shortId,
  type ActiveShipmentStatus,
  type Shipment,
  type ShipmentEvent,
} from "@/lib/api";
import { deriveVesselCondition, isAisFresh, vesselConditionLabel } from "@/lib/aisAutomation";
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

/** A status-change event may come from `advanceStatus` (field "Status",
 * category "status") or from the manual-override path via
 * `saveShipmentDetails` (field "status", category "event" — its generic
 * patch mechanism doesn't know "status" is special). Matching on the field
 * name rather than category catches both, so every status change appears
 * in the Change History regardless of which existing code path wrote it. */
function isStatusEvent(e: ShipmentEvent) {
  return (e.field ?? "").toLowerCase() === "status";
}

function eventSourceLabel(e: ShipmentEvent) {
  if (!e.automated) return "Manual";
  return e.source === "ais" ? "Automated (AIS)" : "Automated (System)";
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
  const { data: ports = [] } = useQuery({ queryKey: ["ports"], queryFn: () => listPorts() });
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
        origin_port_id: draft.origin_port_id,
        destination: draft.destination,
        destination_port_id: draft.destination_port_id,
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
  const hasFreshAis = isAisFresh(position ?? null, Date.now());
  const decision = deriveAutomation(shipment, config, hasFreshAis);
  const vesselCondition = deriveVesselCondition(shipment, position ?? null);
  const conditionLabel = vesselConditionLabel(vesselCondition);
  const shipmentAlerts = alerts.filter((a) => a.shipment_id === shipment.id);
  const statusEvents = events.filter(isStatusEvent);
  const lastStatusChange = statusEvents[0]?.occurred_at ?? shipment.updated_at;

  const openOverride = () => {
    setOverrideStatus((next ?? shipment.status) as ActiveShipmentStatus);
    setOverrideOpen((v) => !v);
  };

  return (
    <AppShell
      title={
        <span className="inline-flex items-center gap-2">
          <Link
            to="/"
            aria-label="Back to shipments"
            className="focus-ring -ml-1 rounded-sm p-1 text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
          </Link>
          Shipment #{shipment.reference ?? shortId(shipment.id)}
        </span>
      }
      actions={
        <>
          <StatusPill status={shipment.status} />
          <HeaderMenu
            next={next}
            advancing={advance.isPending}
            onAdvance={() => advance.mutate()}
            onDelete={() => {
              if (confirm("Delete this shipment and its documents?")) remove.mutate();
            }}
          />
        </>
      }
    >
      <div className="-mt-2 mb-4 flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`-mb-px border-b-2 px-3 py-2 text-[13px] font-medium transition-colors ${
              tab === t.key
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
            {t.key === "alerts" && shipmentAlerts.length > 0 ? ` (${shipmentAlerts.length})` : ""}
          </button>
        ))}
      </div>

      {tab === "overview" ? (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
            <section className="panel p-4">
              <h2 className="label-xs mb-2">Status</h2>
              <StatusPill status={shipment.status} size="lg" />
              {conditionLabel ? (
                <div className="mt-2.5">
                  <p className="label-xs mb-1">Operational</p>
                  <VesselConditionBadge condition={vesselCondition} label={conditionLabel} />
                </div>
              ) : null}
              <div className="mt-3">
                <p className="label-xs">Last updated</p>
                <p className="text-[13px] text-foreground">{formatDayTime(lastStatusChange)}</p>
              </div>

              <div className="my-4 border-t border-border" />

              <h2 className="label-xs mb-2">Current Vessel</h2>
              {shipment.vessel_name || shipment.vessel_mmsi ? (
                <div className="flex items-center gap-3">
                  <span className="flex size-12 shrink-0 items-center justify-center rounded-sm border border-border bg-subtle text-muted-foreground">
                    <Ship className="size-5" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-[14px] font-semibold text-foreground">
                      {shipment.vessel_name ?? "Unnamed vessel"}
                    </p>
                    <p className="text-[12px] text-muted-foreground">
                      {shipment.carrier ? `${shipment.carrier} · ` : ""}
                      MMSI {shipment.vessel_mmsi ?? "—"}
                    </p>
                  </div>
                </div>
              ) : (
                <p className="text-[12px] text-muted-foreground">No vessel assigned to this shipment yet.</p>
              )}

              {shipment.vessel_mmsi ? (
                <div className="mt-3 rounded-[var(--radius)] border border-border bg-subtle/60 p-3">
                  {position ? (
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-2.5">
                        <AisRow
                          icon={ArrowUp}
                          label="SOG"
                          value={position.sog != null ? `${position.sog.toFixed(1)} kn` : "—"}
                        />
                        <AisRow
                          icon={ArrowUpRight}
                          label="COG"
                          value={position.cog != null ? `${position.cog}°` : "—"}
                        />
                        <AisRow icon={MapPin} label="Nav Status" value={navStatusLabel(position.nav_status)} />
                      </div>
                      <Link
                        to="/map"
                        className="inline-flex shrink-0 items-center gap-1 self-center text-[12px] font-medium text-primary hover:underline"
                      >
                        View on map <ArrowRight className="size-3.5" />
                      </Link>
                    </div>
                  ) : (
                    <p className="text-[12px] text-muted-foreground">
                      No AIS position received yet for MMSI {shipment.vessel_mmsi}.
                    </p>
                  )}
                </div>
              ) : null}

              <button
                type="button"
                disabled={legacyTerminal}
                onClick={openOverride}
                className="mt-4 flex w-full items-center justify-between gap-2 rounded-[var(--radius)] border border-primary/30 bg-primary/[0.05] px-4 py-3 text-[13px] font-semibold text-primary transition-colors hover:bg-primary/[0.09] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="inline-flex items-center gap-2">
                  <RotateCcw className="size-4" />
                  Override Status
                </span>
                <ChevronRight className="size-4" />
              </button>

              {legacyTerminal ? (
                <p className="mt-2 text-[12px] text-muted-foreground">
                  This shipment holds a legacy status and has moved past the active lifecycle.
                </p>
              ) : overrideOpen ? (
                <div className="mt-3 space-y-3 rounded-sm border border-border bg-subtle/40 p-3">
                  <p className="text-[12px] text-muted-foreground">
                    Use this if you need to correct a status change, like an accidental update or
                    incorrect AIS data. This will create a manual timeline event. Automation remains
                    primary.
                  </p>
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
              ) : null}
            </section>

            <div className="flex flex-col gap-4">
              <ShipmentNotes shipmentId={id} />

              <section className="panel p-4">
                <h2 className="mb-3 text-[13px] font-semibold">Change History</h2>
                {statusEvents.length === 0 ? (
                  <p className="text-[12px] text-muted-foreground">No status changes recorded yet.</p>
                ) : (
                  <ol>
                    {statusEvents.map((e, i) => (
                      <li key={e.id} className="relative flex gap-3 pb-4 last:pb-0">
                        {i < statusEvents.length - 1 ? (
                          <span
                            aria-hidden
                            className="absolute left-[4px] top-3 h-full w-px bg-border"
                          />
                        ) : null}
                        <span
                          aria-hidden
                          className={`mt-1 size-[9px] shrink-0 rounded-full ${i === 0 ? "bg-primary" : "bg-border"}`}
                        />
                        <div className="min-w-0">
                          <p className="text-[13px] font-semibold text-foreground">
                            {e.to_value ?? e.event_type}
                          </p>
                          <p className="text-[12px] text-muted-foreground">{eventSourceLabel(e)}</p>
                          <p className="text-[11px] text-muted-foreground">{formatDayTime(e.occurred_at)}</p>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </div>
          </div>

          <section className="panel p-4">
            <h2 className="mb-3 text-[13px] font-semibold">Lifecycle</h2>
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

          <form
            className="panel p-4"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <h2 className="mb-3 text-[13px] font-semibold">Shipment Information</h2>
            <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
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
              <PortAutocomplete
                label="Origin"
                value={draft.origin}
                portId={draft.origin_port_id}
                ports={ports}
                onChange={({ text, portId }) => setDraft({ ...draft, origin: text, origin_port_id: portId })}
              />
              <PortAutocomplete
                label="Destination"
                value={draft.destination}
                portId={draft.destination_port_id}
                ports={ports}
                onChange={({ text, portId }) => setDraft({ ...draft, destination: text, destination_port_id: portId })}
              />
              <Field label="Vessel">
                <input
                  className={fieldClass}
                  value={draft.vessel_name ?? ""}
                  onChange={(e) => setDraft({ ...draft, vessel_name: e.target.value })}
                />
              </Field>
              <Field label="MMSI">
                <input
                  className={fieldClass}
                  value={draft.vessel_mmsi ?? ""}
                  onChange={(e) => setDraft({ ...draft, vessel_mmsi: e.target.value })}
                />
              </Field>
              <Field label="Planned ETD">
                <input
                  className={fieldClass}
                  type="datetime-local"
                  value={dates.planned_etd}
                  onChange={(e) => setDates({ ...dates, planned_etd: e.target.value })}
                />
              </Field>
              <Field label="Planned ETA">
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
              <Field label="Actual Departure">
                <input
                  className={fieldClass}
                  type="datetime-local"
                  value={dates.actual_departure}
                  onChange={(e) => setDates({ ...dates, actual_departure: e.target.value })}
                />
              </Field>
              <Field label="Actual Arrival">
                <input
                  className={fieldClass}
                  type="datetime-local"
                  value={dates.actual_arrival}
                  onChange={(e) => setDates({ ...dates, actual_arrival: e.target.value })}
                />
              </Field>
              <InfoField
                label="Last AIS Update"
                value={
                  position ? relativeTime(position.position_timestamp ?? position.updated_at) : "No AIS data yet"
                }
              />
            </div>

            <div className="mt-4 flex items-center justify-end border-t border-border pt-3">
              <button className={btnPrimary} type="submit" disabled={save.isPending}>
                {save.isPending ? "Saving…" : "Save changes"}
              </button>
            </div>
          </form>
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

function HeaderMenu({
  next,
  advancing,
  onAdvance,
  onDelete,
}: {
  next: string | null;
  advancing: boolean;
  onAdvance: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className="focus-ring rounded-sm p-1.5 text-muted-foreground hover:bg-subtle hover:text-foreground"
        aria-label="More actions"
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal className="size-4" />
      </button>
      {open ? (
        <div className="absolute right-0 z-10 mt-1 w-48 rounded-[var(--radius)] border border-border bg-surface py-1">
          {next ? (
            <button
              type="button"
              className="block w-full px-3 py-1.5 text-left text-[13px] text-foreground hover:bg-subtle disabled:opacity-50"
              disabled={advancing}
              onClick={() => {
                onAdvance();
                setOpen(false);
              }}
            >
              Advance to {next}
            </button>
          ) : null}
          <button
            type="button"
            className="block w-full px-3 py-1.5 text-left text-[13px] text-destructive hover:bg-risk-soft"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          >
            Delete shipment
          </button>
        </div>
      ) : null}
    </div>
  );
}

function AisRow({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <div>
        <p className="text-[11px] text-muted-foreground">{label}</p>
        <p className="text-[13px] font-medium text-foreground">{value}</p>
      </div>
    </div>
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

function InfoField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="label-xs mb-1 block">{label}</span>
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
