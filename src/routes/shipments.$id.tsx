import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
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
import { SeverityBadge, StatusPill, VesselConditionBadge, statusAccent, type StatusAccent } from "@/components/StatusPill";
import { useMonitoringConfig } from "@/hooks/useMonitoringConfig";
import {
  ACTIVE_STATUSES,
  advanceStatus,
  deleteShipment,
  formatEta,
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
import { haversineDistanceKm } from "@/lib/geo";
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

const ACCENT_DOT: Record<StatusAccent, string> = {
  neutral: "bg-muted-foreground/60",
  primary: "bg-primary",
  positive: "bg-positive",
  warning: "bg-warning",
};

const ACCENT_RING: Record<StatusAccent, { bg: string; text: string }> = {
  neutral: { bg: "bg-muted-foreground", text: "text-muted-foreground" },
  primary: { bg: "bg-primary", text: "text-primary-deep" },
  positive: { bg: "bg-positive", text: "text-positive" },
  warning: { bg: "bg-warning", text: "text-warning" },
};

/** `shipment_events.to_value` is a plain string column — safely resolve it
 * back to a known status for colour purposes, defaulting to neutral for
 * anything unrecognized rather than guessing. */
function accentForValue(value: string | null): StatusAccent {
  const known = ACTIVE_STATUSES.find((s) => s === value);
  return known ? statusAccent(known) : "neutral";
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
  const portsById = useMemo(() => new Map(ports.map((p) => [p.id, p])), [ports]);

  // Real great-circle progress along the voyage — only rendered when we
  // actually have structured origin/destination ports and a live position
  // to measure from; never estimated or faked otherwise.
  const originPort = shipment?.origin_port_id ? portsById.get(shipment.origin_port_id) : undefined;
  const destPort = shipment?.destination_port_id ? portsById.get(shipment.destination_port_id) : undefined;
  const routeProgress = useMemo(() => {
    if (!originPort || !destPort) return null;
    const totalKm = haversineDistanceKm(
      originPort.latitude,
      originPort.longitude,
      destPort.latitude,
      destPort.longitude,
    );
    if (totalKm < 1 || !position) return null;
    const remainingKm = haversineDistanceKm(
      position.latitude,
      position.longitude,
      destPort.latitude,
      destPort.longitude,
    );
    const pct = Math.max(0, Math.min(1, 1 - remainingKm / totalKm));
    return { pct, totalKm, remainingKm };
  }, [originPort, destPort, position]);

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
        <p className="panel px-4 py-8 text-center text-sm text-muted-foreground">Loading…</p>
      </AppShell>
    );
  }

  if (!shipment || !draft || !dates) {
    return (
      <AppShell title="Shipment not found">
        <div className="panel px-4 py-8 text-center text-sm text-muted-foreground">
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
  const docs = docsFor(documents, shipment.id);
  const health = shipmentHealth(shipment, docs, config);
  const hasFreshAis = isAisFresh(position ?? null, Date.now());
  const decision = deriveAutomation(shipment, config, hasFreshAis);
  const vesselCondition = deriveVesselCondition(shipment, position ?? null);
  const conditionLabel = vesselConditionLabel(vesselCondition);
  const shipmentAlerts = alerts.filter((a) => a.shipment_id === shipment.id);
  const statusEvents = events.filter(isStatusEvent);
  const lastStatusChange = statusEvents[0]?.occurred_at ?? shipment.updated_at;
  const statusDot = ACCENT_DOT[statusAccent(shipment.status)];
  const showHealth = health.level !== "On Track" && health.level !== "Delivered";
  const healthDot = health.level === "Attention" ? "bg-warning" : "bg-risk";

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
            className="focus-ring -ml-1 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-surface hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
          </Link>
          Shipment #{shipment.reference ?? shortId(shipment.id)}
        </span>
      }
      actions={
        <HeaderMenu
          next={next}
          advancing={advance.isPending}
          onAdvance={() => advance.mutate()}
          onDelete={() => {
            if (confirm("Delete this shipment and its documents?")) remove.mutate();
          }}
        />
      }
      headerExtra={
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-start gap-x-10 gap-y-5">
            <HeaderStat
              label="Status"
              value={
                <span className="inline-flex items-center gap-2">
                  <span aria-hidden className={`size-2 shrink-0 rounded-full ${statusDot}`} />
                  {shipment.status}
                </span>
              }
            />
            {showHealth ? (
              <HeaderStat
                label="Health"
                value={
                  <span className={`inline-flex items-center gap-2 ${health.level === "Attention" ? "text-warning" : "text-risk"}`}>
                    <span aria-hidden className={`size-2 shrink-0 rounded-full ${healthDot}`} />
                    {health.level}
                  </span>
                }
              />
            ) : null}
            <HeaderStat label="ETA" value={formatEta(shipment.eta)} />
            <HeaderStat label="Documents" value={`${docs.attached}/${docs.total}`} />
            <HeaderStat label="Updated" value={relativeTime(lastStatusChange)} />
          </div>

          <RouteBar origin={shipment.origin} destination={shipment.destination} progress={routeProgress} />

          {showHealth ? <p className="text-xs text-muted-foreground">{health.reason}</p> : null}

          {shipmentAlerts.length > 0 ? (
            <button
              type="button"
              onClick={() => setTab("alerts")}
              className="flex items-center gap-2 border-t border-border pt-5 text-left text-sm"
            >
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-risk" />
              <span className="font-medium text-foreground">
                {shipmentAlerts.length} alert{shipmentAlerts.length === 1 ? "" : "s"} on this shipment
              </span>
              <span className="text-xs font-medium text-primary">Review →</span>
            </button>
          ) : null}
        </div>
      }
    >
      <div className="-mt-3 mb-6 flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`-mb-px border-b-2 px-3.5 py-2.5 text-sm font-medium transition-colors duration-150 ${
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
        <div className="flex flex-col gap-9">
          <section>
            <h2 className="label-xs mb-4">Lifecycle</h2>
            <LifecycleJourney status={shipment.status} legacyTerminal={legacyTerminal} currentIndex={currentIndex} />
            <div className="mt-5 flex flex-col gap-1 border-t border-border pt-4 text-xs text-muted-foreground sm:flex-row sm:gap-6">
              <p>Monitoring: {monitoring.reason}</p>
              <p>
                Automation:{" "}
                {decision.status === shipment.status ? "no pending change" : `will move to ${decision.status}`}
                {" · "}
                {decision.reason}
              </p>
            </div>
          </section>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.4fr_1fr]">
            <section className="panel p-5">
              <div className="flex items-center justify-between">
                <h2 className="label-xs">Vessel &amp; Live Position</h2>
                {shipment.vessel_mmsi ? (
                  <Link
                    to="/map"
                    className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary hover:underline"
                  >
                    View on map <ArrowRight className="size-3.5" />
                  </Link>
                ) : null}
              </div>

              {shipment.vessel_name || shipment.vessel_mmsi ? (
                <div className="mt-3 flex items-center gap-3">
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-md border border-border bg-subtle text-muted-foreground">
                    <Ship className="size-5" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-base font-semibold text-foreground">
                      {shipment.vessel_name ?? "Unnamed vessel"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {shipment.carrier ? `${shipment.carrier} · ` : ""}
                      MMSI <span className="instrument">{shipment.vessel_mmsi ?? "—"}</span>
                      {conditionLabel ? " · " : ""}
                      {conditionLabel ? (
                        <VesselConditionBadge condition={vesselCondition} label={conditionLabel} />
                      ) : null}
                    </p>
                  </div>
                </div>
              ) : (
                <p className="mt-3 text-xs text-muted-foreground">No vessel assigned to this shipment yet.</p>
              )}

              {shipment.vessel_mmsi ? (
                position ? (
                  <div className="console mt-4 p-4">
                    <div className="flex items-center justify-between">
                      <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.07em] text-nav-foreground">
                        <span
                          className={`size-1.5 rounded-full ${hasFreshAis ? "bg-nav-accent live-pulse" : "bg-nav-muted-foreground"}`}
                          aria-hidden
                        />
                        {hasFreshAis ? "Live Position" : "Last Known Position"}
                      </span>
                      <span className="instrument text-xs text-nav-muted-foreground">
                        {relativeTime(position.position_timestamp ?? position.updated_at)}
                      </span>
                    </div>
                    <div className="mt-4 grid grid-cols-[0.75fr_0.75fr_1.3fr] gap-4">
                      <ConsoleSpeed sog={position.sog} />
                      <ConsoleHeading cog={position.cog} />
                      <ConsoleField label="Nav Status" value={navStatusLabel(position.nav_status)} />
                    </div>
                  </div>
                ) : (
                  <p className="mt-4 rounded-lg border border-border bg-subtle/60 p-3.5 text-xs text-muted-foreground">
                    No AIS position received yet for MMSI{" "}
                    <span className="instrument">{shipment.vessel_mmsi}</span>.
                  </p>
                )
              ) : null}

              <button
                type="button"
                disabled={legacyTerminal}
                onClick={openOverride}
                className="mt-4 flex w-full items-center justify-between gap-2 rounded-md border border-border bg-surface px-3.5 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:border-primary/30 hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="inline-flex items-center gap-2">
                  <RotateCcw className="size-3.5" />
                  Override Status
                </span>
                <ChevronRight className="size-3.5" />
              </button>

              {legacyTerminal ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  This shipment holds a legacy status and has moved past the active lifecycle.
                </p>
              ) : overrideOpen ? (
                <div className="mt-3 space-y-3 rounded-lg border border-border bg-subtle/50 p-3.5">
                  <p className="text-xs text-muted-foreground">
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

            <div className="flex flex-col gap-6">
              <ShipmentNotes shipmentId={id} />

              <section>
                <h2 className="label-xs mb-3">Change History</h2>
                {statusEvents.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No status changes recorded yet.</p>
                ) : (
                  <ol>
                    {statusEvents.map((e, i) => {
                      const dotColor = ACCENT_DOT[accentForValue(e.to_value)];
                      return (
                        <li key={e.id} className="relative flex gap-3 pb-4 last:pb-0">
                          {i < statusEvents.length - 1 ? (
                            <span aria-hidden className="absolute left-[4px] top-3 h-full w-px bg-border" />
                          ) : null}
                          <span
                            aria-hidden
                            className={`mt-1 size-[9px] shrink-0 rounded-full ${dotColor} ${i === 0 ? "" : "opacity-45"}`}
                          />
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-foreground">{e.to_value ?? e.event_type}</p>
                            <p className="text-xs text-muted-foreground">{eventSourceLabel(e)}</p>
                            <p className="text-xs text-muted-foreground">{formatDayTime(e.occurred_at)}</p>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </section>
            </div>
          </div>

          <form
            className="panel p-5"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <h2 className="label-xs mb-3">Shipment Information</h2>
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
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              No alerts recorded for this shipment.
            </p>
          ) : (
            shipmentAlerts.map((a) => {
              const severity = alertSeverity(a);
              return (
                <div key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
                  <SeverityBadge severity={severity} label={SEVERITY_LABEL[severity]} />
                  <span className="flex-1 text-sm text-foreground">{a.message}</span>
                  <span className="flex items-center gap-1.5">
                    {a.from_status ? <StatusPill status={a.from_status} /> : null}
                    {a.from_status && a.to_status ? (
                      <span className="text-xs text-muted-foreground">→</span>
                    ) : null}
                    {a.to_status ? <StatusPill status={a.to_status} /> : null}
                  </span>
                  <span className="w-32 shrink-0 text-right text-xs text-muted-foreground">
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
        className="focus-ring rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-surface hover:text-foreground"
        aria-label="More actions"
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal className="size-4" />
      </button>
      {open ? (
        <div className="panel-lifted animate-in absolute right-0 z-10 mt-1.5 w-48 overflow-hidden p-1">
          {next ? (
            <button
              type="button"
              className="block w-full rounded-md px-2.5 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-subtle disabled:opacity-50"
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
            className="block w-full rounded-md px-2.5 py-1.5 text-left text-sm text-destructive transition-colors hover:bg-risk-soft"
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

/** Label-over-value readout — the same visual language as the dashboard's
 * KPI strip, reused here so a shipment's vitals read the same way an
 * operator already reads the fleet's. */
function HeaderStat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="label-xs">{label}</span>
      <span className="instrument truncate text-lg font-medium text-foreground">{value}</span>
    </div>
  );
}

/** A field inside the console — the dark, live register. Label in small
 * caps, value in instrument mono, both tuned for the nav palette rather
 * than the page's light "business" colours. */
function ConsoleField({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-medium uppercase tracking-[0.08em] text-nav-muted-foreground">{label}</p>
      <p className="instrument mt-1 truncate text-base font-medium text-nav-foreground">{value}</p>
    </div>
  );
}

/** Speed over ground as an instrument, not just a number — a bounded,
 * glowing gauge (0–28kn, the range that covers virtually every cargo
 * vessel) makes "fast" or "slow" legible at a glance. */
function ConsoleSpeed({ sog }: { sog: number | null }) {
  const pct = sog != null ? Math.max(0, Math.min(100, (sog / 28) * 100)) : 0;
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-medium uppercase tracking-[0.08em] text-nav-muted-foreground">SOG</p>
      <p className="instrument mt-1 truncate text-base font-medium text-nav-foreground">
        {sog != null ? `${sog.toFixed(1)} kn` : "—"}
      </p>
      <div className="mt-2 h-[3px] w-full overflow-hidden rounded-full bg-nav-border">
        <div
          className="h-full rounded-full bg-nav-accent shadow-[0_0_6px_0_var(--nav-accent)] transition-[width] duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/** Course over ground as a heading, not just a number — the arrow rotates
 * to the vessel's real bearing (0° = due north, clockwise), so direction
 * of travel is visible without reading a degree symbol. */
function ConsoleHeading({ cog }: { cog: number | null }) {
  return (
    <div className="min-w-0">
      <p className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-nav-muted-foreground">
        <ArrowUp
          className="size-3 shrink-0 text-nav-accent transition-transform duration-500"
          style={cog != null ? { transform: `rotate(${cog}deg)` } : undefined}
        />
        COG
      </p>
      <p className="instrument mt-1 truncate text-base font-medium text-nav-foreground">
        {cog != null ? `${cog}°` : "—"}
      </p>
    </div>
  );
}

/** The route as real distance, not decoration: when the shipment has
 * structured origin/destination ports and a live position, the fill and
 * marker reflect actual great-circle progress toward the destination —
 * a vessel crossing genuine distance, not a stand-in percentage. Falls
 * back to a plain endpoints line when that data isn't available, rather
 * than estimating. */
function RouteBar({
  origin,
  destination,
  progress,
}: {
  origin: string;
  destination: string;
  progress: { pct: number; totalKm: number; remainingKm: number } | null;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate text-lg font-semibold text-foreground">{origin}</span>
        <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-right text-lg font-semibold text-foreground">{destination}</span>
      </div>
      <div className="relative mt-3 h-[3px] w-full rounded-full bg-atmosphere-hover">
        {progress ? (
          <>
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-primary transition-[width] duration-700"
              style={{ width: `${progress.pct * 100}%` }}
            />
            <div
              aria-hidden
              className="live-pulse absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary shadow-[0_0_6px_0_var(--primary)] transition-[left] duration-700"
              style={{ left: `${progress.pct * 100}%` }}
            />
          </>
        ) : null}
      </div>
      {progress ? (
        <p className="instrument mt-2 text-xs text-muted-foreground">
          {Math.round(progress.pct * 100)}% underway · {Math.round(progress.remainingKm).toLocaleString()} km to
          destination
        </p>
      ) : null}
    </div>
  );
}

/** The shipment's journey as a line, not a generic numbered progress bar:
 * a filled track behind everything already reached, a pulsing marker
 * exactly where the shipment is now, and hollow ticks for what's ahead —
 * position on a route, read at a glance. */
function LifecycleJourney({
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
          const c = ACCENT_RING[statusAccent(s)];
          return (
            <li key={s} className="flex flex-1 flex-col items-center">
              <div className="flex w-full items-center">
                <span className={`h-[2px] flex-1 ${isFirst ? "opacity-0" : done || current ? c.bg : "bg-border"}`} />
                <span className="relative grid shrink-0 place-items-center" style={{ width: 14, height: 14 }}>
                  {current ? (
                    <span aria-hidden className={`live-pulse absolute size-3.5 rounded-full ${c.bg} opacity-20`} />
                  ) : null}
                  <span
                    aria-hidden
                    className={`relative rounded-full ${
                      current
                        ? `size-2 ${c.bg}`
                        : done
                          ? `size-[7px] ${c.bg}`
                          : "size-[7px] border-[1.5px] border-border bg-surface"
                    }`}
                  />
                </span>
                <span className={`h-[2px] flex-1 ${isLast ? "opacity-0" : done ? c.bg : "bg-border"}`} />
              </div>
              <span
                className={`mt-2 text-center text-xs leading-tight ${
                  current ? `font-semibold ${c.text}` : done ? "text-foreground" : "text-muted-foreground"
                }`}
              >
                {s}
              </span>
            </li>
          );
        })}
      </ol>
      {legacyTerminal ? (
        <p className="mt-3 text-xs text-muted-foreground">
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
      <span className="text-sm text-foreground">{value}</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="label-xs mb-1 block">{label}</span>
      {children}
    </label>
  );
}
