import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, ChevronRight, MoreHorizontal } from "lucide-react";
import { toast } from "sonner";

import { AppShell, btnGhost, btnPrimary, fieldClass } from "@/components/AppShell";
import { DocumentFiles } from "@/components/DocumentFiles";
import { PortAutocomplete } from "@/components/PortAutocomplete";
import { ShipmentNotes } from "@/components/ShipmentNotes";
import { ShipmentTimeline } from "@/components/ShipmentTimeline";
import { StatusHistory } from "@/components/StatusHistory";
import { SeverityBadge, StatusPill } from "@/components/StatusPill";
import { useMonitoringConfig } from "@/hooks/useMonitoringConfig";
import {
  conditionOf,
  formatCoordinates,
  humanField,
  logValue,
  slipLabel,
  targetOf,
  tCount,
  utcClock,
  utcDayTime,
  voyageOf,
} from "@/components/maritime/format";
import { Bearing, ConditionMark, PhaseLadder, SourceMark } from "@/components/maritime/marks";
import { useNow } from "@/components/maritime/useNow";
import { VoyagePlot } from "@/components/maritime/VoyagePlot";
import {
  ACTIVE_STATUSES,
  advanceStatus,
  deleteShipment,
  getPortById,
  getShipment,
  getVesselPositionForShipment,
  listAlerts,
  listDocuments,
  listEvents,
  nextStatus,
  resumeAutomation,
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
  activeAutomationHold,
  alertSeverity,
  docsFor,
  drift,
  formatUtcMinute,
  monitoringInfo,
  navStatusLabel,
  relativeTime,
  SEVERITY_LABEL,
  shipmentHealth,
} from "@/lib/lifecycle";

export const Route = createFileRoute("/shipments/$id")({
  head: () => ({
    meta: [
      { title: "Voyage record - StimTech Solutions" },
      {
        name: "description",
        content:
          "Edit shipment schedule and details, follow the automated status pipeline and tick off required trade documents.",
      },
      { property: "og:title", content: "Voyage record - StimTech Solutions" },
      {
        property: "og:description",
        content:
          "Planned, current and actual dates, automated status pipeline, document checklist and audit trail.",
      },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  // The open tab lives in the URL, so a link can land on a voyage's
  // documents or log, and back/forward restore it.
  validateSearch: (search: Record<string, unknown>): { tab?: TabKey } =>
    TABS.some((t) => t.key === search["tab"]) && search["tab"] !== "overview"
      ? { tab: search["tab"] as TabKey }
      : {},
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
  const now = useNow();
  const tab: TabKey = Route.useSearch().tab ?? "overview";
  const setTab = (next: TabKey) =>
    navigate({
      to: "/shipments/$id",
      params: { id },
      search: next === "overview" ? {} : { tab: next },
      replace: true,
      resetScroll: false,
    });

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
    // A vessel that's moving should feel alive: poll for a fresher AIS
    // read instead of only ever showing what was there on page load.
    refetchInterval: 30_000,
  });

  // Two targeted lookups rather than fetching the entire (several-thousand
  // row) port reference table just to resolve two known ids.
  const { data: originPort } = useQuery({
    queryKey: ["port", shipment?.origin_port_id ?? null],
    queryFn: () => getPortById(shipment!.origin_port_id!),
    enabled: Boolean(shipment?.origin_port_id),
  });
  const { data: destPort } = useQuery({
    queryKey: ["port", shipment?.destination_port_id ?? null],
    queryFn: () => getPortById(shipment!.destination_port_id!),
    enabled: Boolean(shipment?.destination_port_id),
  });

  // Real great-circle progress along the voyage — only rendered when we
  // actually have structured origin/destination ports and a live position
  // to measure from; never estimated or faked otherwise.
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
  // Editing is occasional; monitoring is constant. The form stays out of
  // the way until someone actually needs to change something.
  const [editOpen, setEditOpen] = useState(false);

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
      await saveShipmentDetails(
        shipment,
        { status: overrideStatus },
        overrideReason.trim() || null,
      );
    },
    onSuccess: () => {
      refresh();
      toast.success(`Status manually changed to ${overrideStatus}`);
      setOverrideOpen(false);
      setOverrideReason("");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const resume = useMutation({
    mutationFn: async () => {
      if (!shipment) return "noop";
      return resumeAutomation(shipment.id);
    },
    onSuccess: (outcome) => {
      refresh();
      if (outcome === "applied") toast.success("Automation resumed");
      else toast.info("Automation was not on hold");
    },
    onError: (e: Error) => toast.error(`Could not resume automation: ${e.message}`),
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
      <AppShell title="Shipment" bare>
        <div className="mx-auto w-full max-w-[1320px] px-4 pt-6 sm:px-6 lg:px-8">
          <div className="h-3 w-40 animate-pulse bg-sea-paper-2" />
          <div className="mt-3 h-8 w-72 max-w-full animate-pulse bg-sea-paper-2" />
          <div className="mt-6 h-16 w-full animate-pulse bg-sea-paper-2" />
          <div className="mt-6 h-[104px] w-full animate-pulse bg-sea-paper-2" />
        </div>
      </AppShell>
    );
  }

  if (!shipment || !draft || !dates) {
    return (
      <AppShell title="Shipment not found">
        <div className="max-w-[60ch] py-6">
          <p className="text-[14px] font-medium text-sea-ink">No voyage record at this address</p>
          <p className="mt-1 text-[13px] text-sea-ink-2">
            The shipment may have been deleted, or the link is incomplete.
          </p>
          <Link
            to="/shipments"
            className="focus-ring mt-4 inline-flex text-[13px] font-medium text-sea-ink underline decoration-sea-ink-4 underline-offset-2"
          >
            Back to the shipment board
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
  // ETA as a live variable, not a fixed date: how far the current estimate
  // has moved from the original plan, if it has moved at all.
  const etaDrift = drift(shipment.planned_eta, shipment.eta);
  const decision = deriveAutomation(shipment, config, hasFreshAis);
  const automationHold = activeAutomationHold(shipment);
  const vesselCondition = deriveVesselCondition(shipment, position ?? null);
  const conditionLabel = vesselConditionLabel(vesselCondition);
  const shipmentAlerts = alerts.filter((a) => a.shipment_id === shipment.id);
  const statusEvents = events.filter(isStatusEvent);
  const level = conditionOf(health.level);
  const voyage = voyageOf(shipment, now);
  const target = targetOf(
    position ?? null,
    position ? vesselCondition.kind : null,
    Boolean(shipment.vessel_mmsi),
    now,
  );
  const etaCount = shipment.eta && now != null ? tCount(shipment.eta, now) : null;
  // The automation reason repeats the monitoring reason as its preamble;
  // show only what it adds.
  const automationDetail = decision.reason.startsWith(monitoring.reason)
    ? decision.reason.slice(monitoring.reason.length).replace(/^[\s\u2014\-.;,]+/, "")
    : decision.reason;
  const reachedAt = (phase: string) =>
    statusEvents.find((e) => e.to_value === phase)?.occurred_at ?? null;

  const openOverride = () => {
    setOverrideStatus((next ?? shipment.status) as ActiveShipmentStatus);
    setOverrideOpen((v) => !v);
  };

  const signal: { tone: string; label: string; sub: string } = !shipment.vessel_mmsi
    ? { tone: "text-sea-ink-3", label: "Not tracked", sub: "No MMSI recorded" }
    : !position
      ? { tone: "text-sea-ink-3", label: "Awaiting fix", sub: `MMSI ${shipment.vessel_mmsi}` }
      : hasFreshAis
        ? {
            tone: "text-sea-ink",
            label: relativeTime(position.position_timestamp ?? position.updated_at),
            sub: "Receiving",
          }
        : {
            tone: "text-sea-amber-ink",
            label: relativeTime(position.position_timestamp ?? position.updated_at),
            sub: "Stale, over 24h",
          };

  return (
    <AppShell title={shipment.client_name} bare>
      <div className="mx-auto w-full max-w-[1320px] px-4 pb-14 sm:px-6 lg:px-8">
        {/* ----------------------------------------------------- record header */}
        <header className="pt-5">
          <div className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px]">
              <Link
                to="/shipments"
                aria-label="Back to shipments"
                className="focus-ring grid size-7 shrink-0 place-items-center rounded-md border border-sea-rule bg-sea-surface text-sea-ink-2 transition-colors hover:border-ww-blue-line hover:text-ww-blue"
              >
                <ArrowLeft className="size-3.5" aria-hidden />
              </Link>
              <span className="ref-tag">{shortId(shipment.id)}</span>
              {shipment.reference ? (
                <span className="telemetry text-[10.5px] uppercase text-sea-ink-3">
                  Ref {shipment.reference}
                </span>
              ) : null}
              {shipment.container_number ? (
                <span className="telemetry hidden text-[10.5px] uppercase text-sea-ink-3 sm:inline">
                  Cntr {shipment.container_number}
                </span>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {next && !legacyTerminal ? (
                <span className="hidden sm:block">
                  <button
                    type="button"
                    className={btnGhost}
                    disabled={advance.isPending}
                    onClick={() => advance.mutate()}
                  >
                    {advance.isPending ? "Advancing…" : `Advance to ${next}`}
                  </button>
                </span>
              ) : null}
              <HeaderMenu
                next={next}
                advancing={advance.isPending}
                onAdvance={() => advance.mutate()}
                onDelete={() => {
                  if (confirm("Delete this shipment and its documents?")) remove.mutate();
                }}
              />
            </div>
          </div>

          <h1 className="display mt-2 text-[30px] leading-[34px] text-sea-ink">
            {shipment.client_name}
          </h1>

          <dl className="mt-5 grid grid-cols-2 border-y border-sea-rule sm:grid-cols-3 lg:grid-cols-[1.1fr_1.1fr_1.2fr_1.1fr_0.9fr]">
            <HeaderStat label="Phase">
              <span className="flex items-center gap-2.5">
                <PhaseLadder status={shipment.status} size="md" />
                <span className="truncate">{shipment.status}</span>
              </span>
              <HeaderSub>
                {automationHold ? (
                  <span className="text-sea-amber-ink">
                    Automation held to {utcClock(automationHold.getTime())}Z
                  </span>
                ) : voyage.day ? (
                  `Day ${voyage.day.elapsed} of ${voyage.day.total}`
                ) : legacyTerminal ? (
                  "Legacy status"
                ) : (
                  `Phase ${currentIndex + 1} of ${ACTIVE_STATUSES.length}`
                )}
              </HeaderSub>
            </HeaderStat>
            <HeaderStat label="Vessel">
              <span
                className={`truncate ${shipment.vessel_name ? "vessel !font-semibold" : "text-sea-ink-3"}`}
              >
                {shipment.vessel_name ?? "Not assigned"}
              </span>
              <HeaderSub mono>
                {shipment.vessel_mmsi ? `MMSI ${shipment.vessel_mmsi}` : "No MMSI"}
                {shipment.carrier ? `  ${shipment.carrier}` : ""}
              </HeaderSub>
            </HeaderStat>
            <HeaderStat label="Position">
              {position && target.state !== "none" ? (
                <span className="telemetry truncate text-[13px]">
                  {formatCoordinates(position.latitude, position.longitude)}
                </span>
              ) : (
                <span className="text-sea-ink-3">No fix</span>
              )}
              <HeaderSub mono>
                {position && target.sog != null ? (
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className={
                        target.state === "active" && voyage.pos != null && !voyage.arrived
                          ? "text-sea-move"
                          : ""
                      }
                    >
                      SOG {target.sog.toFixed(1)} KN
                    </span>
                    {target.cog != null ? (
                      <>
                        <Bearing deg={target.cog} className="text-sea-ink-2" size={9} />
                        COG {String(Math.round(target.cog)).padStart(3, "0")}°
                      </>
                    ) : null}
                  </span>
                ) : (
                  (conditionLabel ?? "No reading")
                )}
              </HeaderSub>
            </HeaderStat>
            <HeaderStat label="ETA (UTC)">
              {shipment.actual_arrival ? (
                <span className="text-sea-green">
                  Arrived {utcDayTime(shipment.actual_arrival, now)}
                </span>
              ) : shipment.eta ? (
                <span className={`tabular-nums ${etaCount?.past ? "text-sea-red" : ""}`}>
                  {utcDayTime(shipment.eta, now)}
                </span>
              ) : (
                <span className="text-sea-amber-ink">Not set</span>
              )}
              <HeaderSub mono>
                {etaCount && !shipment.actual_arrival ? (
                  <span className={etaCount.past ? "text-sea-red" : ""}>{etaCount.label}</span>
                ) : null}
                {etaDrift && etaDrift.hours !== 0 && !shipment.actual_arrival ? (
                  <span
                    className={`ml-2 ${etaDrift.tone === "late" ? "text-sea-amber-ink" : ""}`}
                    title={etaDrift.label}
                  >
                    {slipLabel(etaDrift.hours)} vs plan
                  </span>
                ) : null}
              </HeaderSub>
            </HeaderStat>
            <HeaderStat label="AIS signal">
              <span className={`inline-flex items-center gap-2 ${signal.tone}`}>
                <span
                  aria-hidden
                  className={`relative inline-block size-[7px] shrink-0 rounded-full ${
                    hasFreshAis
                      ? "ping-live bg-sea-move text-sea-move"
                      : position
                        ? "bg-sea-amber"
                        : "border border-sea-ink-4"
                  }`}
                />
                {signal.label}
              </span>
              <HeaderSub>{signal.sub}</HeaderSub>
            </HeaderStat>
          </dl>

          {/* The exception, if there is one: what, why, what to do */}
          {level || automationHold ? (
            <div
              role="status"
              className={`panel animate-in mt-4 flex flex-col gap-3 !border-l-[3px] py-3 pl-4 pr-4 sm:flex-row sm:items-center sm:justify-between sm:pl-5 ${
                level === "alarm" ? "!border-l-sea-red" : "!border-l-sea-amber"
              }`}
            >
              <div className="min-w-0">
                {level ? (
                  <p className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                    <span className="inline-flex items-center gap-1.5">
                      <ConditionMark level={level} size={9} />
                      <span
                        className={`chart-label ${level === "alarm" ? "text-sea-red" : "text-sea-amber-ink"}`}
                      >
                        {health.level}
                      </span>
                    </span>
                    <span className="text-[13.5px] font-medium text-sea-ink">
                      {health.action ?? "Review the voyage"}
                    </span>
                  </p>
                ) : null}
                {level ? (
                  <p className="mt-0.5 text-[12.5px] text-sea-ink-2">{health.reason}</p>
                ) : null}
                {automationHold ? (
                  <p className={`text-[12.5px] text-sea-ink-2 ${level ? "mt-1.5" : ""}`}>
                    <span className="chart-label mr-2 text-sea-amber-ink">Automation held</span>
                    An operator corrected this voyage; AIS automation stands down until{" "}
                    <span className="telemetry text-[11px]">{formatUtcMinute(automationHold)}</span>
                    .
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {automationHold ? (
                  <button
                    type="button"
                    className={btnGhost}
                    disabled={resume.isPending}
                    onClick={() => resume.mutate()}
                  >
                    {resume.isPending ? "Resuming…" : "Resume automation"}
                  </button>
                ) : null}
                {shipmentAlerts.length > 0 ? (
                  <button type="button" className={btnGhost} onClick={() => setTab("alerts")}>
                    {shipmentAlerts.length} alert{shipmentAlerts.length === 1 ? "" : "s"}
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </header>

        {/* ------------------------------------------------------- the passage */}
        <div className="panel mt-4 px-4 pb-4 pt-4 sm:px-5">
          <VoyagePlot
            shipment={shipment}
            position={position ?? null}
            condition={position ? vesselCondition.kind : null}
            measured={routeProgress}
            now={now}
          />
        </div>

        {/* -------------------------------------------------------------- tabs */}
        <div
          role="tablist"
          aria-label="Voyage record"
          className="mt-7 flex gap-6 overflow-x-auto border-b border-sea-rule [scrollbar-width:none]"
          onKeyDown={(e) => {
            if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
            const i = TABS.findIndex((t) => t.key === tab);
            const nextTab =
              TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length]!;
            setTab(nextTab.key);
            document.getElementById(`tab-${nextTab.key}`)?.focus();
          }}
        >
          {TABS.map((t) => {
            const count =
              t.key === "alerts"
                ? shipmentAlerts.length
                : t.key === "timeline"
                  ? events.length
                  : t.key === "documents"
                    ? `${docs.attached}/${docs.total}`
                    : null;
            return (
              <button
                key={t.key}
                id={`tab-${t.key}`}
                role="tab"
                type="button"
                aria-selected={tab === t.key}
                tabIndex={tab === t.key ? 0 : -1}
                onClick={() => setTab(t.key)}
                className={`focus-ring -mb-px flex shrink-0 items-center gap-2 border-b-2 pb-2.5 text-[13.5px] transition-colors duration-150 ${
                  tab === t.key
                    ? "border-ww-blue font-medium text-sea-ink"
                    : "border-transparent text-sea-ink-3 hover:text-sea-ink"
                }`}
              >
                {t.label}
                {count != null && count !== 0 ? (
                  <span
                    className={`telemetry text-[10.5px] ${
                      t.key === "alerts" ? "text-sea-red" : "text-sea-ink-3"
                    }`}
                  >
                    {count}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>

        <div role="tabpanel" aria-labelledby={`tab-${tab}`} key={tab} className="animate-in pt-5">
          {tab === "overview" ? (
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,380px)]">
              <div className="flex min-w-0 flex-col gap-5">
                <section
                  aria-labelledby="lifecycle-title"
                  className="panel min-w-0 px-4 pb-3 sm:px-5 [&_li:last-child]:border-b-0"
                >
                  <h2
                    id="lifecycle-title"
                    className="panel-title -mx-4 border-b border-sea-rule px-4 py-3.5 sm:-mx-5 sm:px-5"
                  >
                    Lifecycle and monitoring
                  </h2>
                  <LifecycleJourney
                    status={shipment.status}
                    legacyTerminal={legacyTerminal}
                    currentIndex={currentIndex}
                    reachedAt={reachedAt}
                  />
                  <dl className="-mx-4 mt-4 divide-y divide-sea-rule-2 border-t border-sea-rule px-4 sm:-mx-5 sm:px-5">
                    <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-4 py-2.5">
                      <dt className="pt-px text-[12px] font-medium text-sea-ink-3">Monitoring</dt>
                      <dd className="text-[13px] text-sea-ink">
                        <span className="font-medium">{monitoring.state}</span>
                        <span className="text-sea-ink-2">. {monitoring.reason}</span>
                      </dd>
                    </div>
                    <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-4 py-2.5">
                      <dt className="pt-px text-[12px] font-medium text-sea-ink-3">Automation</dt>
                      <dd className="text-[13px] text-sea-ink">
                        {automationHold ? (
                          <span className="font-medium text-sea-amber-ink">
                            Held until {formatUtcMinute(automationHold)}
                          </span>
                        ) : decision.status === shipment.status ? (
                          <span className="font-medium">No pending change</span>
                        ) : (
                          <span className="font-medium">Will move to {decision.status}</span>
                        )}
                        {automationDetail ? (
                          <span className="text-sea-ink-2">. {automationDetail}</span>
                        ) : null}
                      </dd>
                    </div>
                  </dl>
                </section>

                <section
                  aria-labelledby="latest-title"
                  className="panel min-w-0 px-4 pb-3 sm:px-5 [&_li:last-child]:border-b-0"
                >
                  <div className="-mx-4 flex min-h-[52px] items-center justify-between border-b border-sea-rule px-4 py-2.5 sm:-mx-5 sm:px-5">
                    <h2 id="latest-title" className="panel-title">
                      Latest entries
                    </h2>
                    {events.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => setTab("timeline")}
                        className="focus-ring inline-flex items-center gap-1 rounded-sm text-[12.5px] font-medium text-ww-blue hover:text-ww-blue-hover"
                      >
                        Full voyage log <ArrowRight className="size-3" aria-hidden />
                      </button>
                    ) : null}
                  </div>
                  {events.length === 0 ? (
                    <p className="py-3 text-[12.5px] text-sea-ink-3">
                      Nothing logged yet. Phase changes, schedule revisions and corrections appear
                      here with their source.
                    </p>
                  ) : (
                    <ol>
                      {events.slice(0, 4).map((e) => (
                        <li
                          key={e.id}
                          className="grid grid-cols-[96px_44px_minmax(0,1fr)] items-baseline gap-x-3 border-b border-sea-rule-2 py-2"
                        >
                          <time className="telemetry text-[10.5px] uppercase text-sea-ink-2">
                            {utcDayTime(e.occurred_at, now)}
                          </time>
                          <span className="flex items-center gap-1.5">
                            <SourceMark source={e.source} automated={e.automated} />
                            <span className="telemetry text-[10px] text-sea-ink-3">
                              {e.source === "ais" ? "AIS" : e.automated ? "SYS" : "OPR"}
                            </span>
                          </span>
                          <span className="truncate text-[12.5px] text-sea-ink">
                            {e.to_value ? (
                              <>
                                <span className="text-sea-ink-2">
                                  {humanField(e.field, e.event_type) || "Phase"}
                                </span>{" "}
                                {e.from_value ? (
                                  <span className="text-sea-ink-3 line-through decoration-sea-ink-4">
                                    {logValue(e.from_value, now)}
                                  </span>
                                ) : null}{" "}
                                <span className="text-sea-ink-4">→</span>{" "}
                                <span className="font-medium">{logValue(e.to_value, now)}</span>
                              </>
                            ) : e.reason ? (
                              logValue(e.reason, now)
                            ) : (
                              e.event_type.replace(/_/g, " ")
                            )}
                          </span>
                        </li>
                      ))}
                    </ol>
                  )}
                </section>

                <section className="panel min-w-0 px-4 pb-3 sm:px-5 [&_li:last-child]:border-b-0">
                  <button
                    type="button"
                    onClick={() => setEditOpen((v) => !v)}
                    aria-expanded={editOpen}
                    className="focus-ring -mx-4 flex w-[calc(100%+2rem)] items-center justify-between border-b border-sea-rule px-4 py-3.5 text-left sm:-mx-5 sm:w-[calc(100%+2.5rem)] sm:px-5"
                  >
                    <span className="panel-title">Shipment information</span>
                    <span className="inline-flex items-center gap-1 text-[12.5px] font-medium text-ww-blue">
                      {editOpen ? "Close" : "Edit details"}
                      <ChevronRight
                        className={`size-3.5 transition-transform duration-200 ${editOpen ? "rotate-90" : ""}`}
                        aria-hidden
                      />
                    </span>
                  </button>

                  {editOpen ? (
                    <form
                      className="animate-in pt-4"
                      onSubmit={(e) => {
                        e.preventDefault();
                        save.mutate();
                      }}
                    >
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
                          onChange={({ text, portId }) =>
                            setDraft({ ...draft, origin: text, origin_port_id: portId })
                          }
                        />
                        <PortAutocomplete
                          label="Destination"
                          value={draft.destination}
                          portId={draft.destination_port_id}
                          onChange={({ text, portId }) =>
                            setDraft({ ...draft, destination: text, destination_port_id: portId })
                          }
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
                            className={`${fieldClass} telemetry`}
                            inputMode="numeric"
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
                        <Field label="Actual departure">
                          <input
                            className={fieldClass}
                            type="datetime-local"
                            value={dates.actual_departure}
                            onChange={(e) =>
                              setDates({ ...dates, actual_departure: e.target.value })
                            }
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
                        <InfoField
                          label="Last AIS update"
                          value={
                            position
                              ? relativeTime(position.position_timestamp ?? position.updated_at)
                              : "No AIS data yet"
                          }
                        />
                      </div>
                      <p className="mt-3 text-[12px] text-sea-ink-3">
                        Dates are entered in your local time and shown on the record in UTC.
                      </p>
                      <div className="mt-3 flex items-center justify-end gap-2 border-t border-sea-rule pt-3">
                        <button
                          type="button"
                          className={btnGhost}
                          onClick={() => setEditOpen(false)}
                        >
                          Cancel
                        </button>
                        <button className={btnPrimary} type="submit" disabled={save.isPending}>
                          {save.isPending ? "Saving…" : "Save changes"}
                        </button>
                      </div>
                    </form>
                  ) : (
                    <dl className="grid grid-cols-2 gap-x-6 sm:grid-cols-3">
                      {(
                        [
                          ["Client", shipment.client_name],
                          ["Reference", shipment.customer_reference ?? shipment.reference],
                          ["Carrier", shipment.carrier],
                          ["Container", shipment.container_number],
                          [
                            "Landed cost",
                            shipment.landed_cost == null
                              ? null
                              : `USD ${shipment.landed_cost.toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
                          ],
                          ["IMO", shipment.vessel_imo],
                          [
                            "Planned ETD",
                            shipment.planned_etd
                              ? `${utcDayTime(shipment.planned_etd, now)} UTC`
                              : null,
                          ],
                          [
                            "Planned ETA",
                            shipment.planned_eta
                              ? `${utcDayTime(shipment.planned_eta, now)} UTC`
                              : null,
                          ],
                          [
                            "Ports linked",
                            shipment.origin_port_id && shipment.destination_port_id
                              ? "Both ports"
                              : shipment.origin_port_id || shipment.destination_port_id
                                ? "One port of two"
                                : "Neither, schedule only",
                          ],
                        ] as [string, string | null][]
                      ).map(([label, value]) => (
                        <div key={label} className="min-w-0 border-b border-sea-rule-2 py-2.5">
                          <dt className="chart-label !text-[9.5px] text-sea-ink-3">{label}</dt>
                          <dd
                            className={`mt-0.5 truncate text-[13px] ${value ? "text-sea-ink" : "text-sea-ink-4"}`}
                          >
                            {value ?? "Not recorded"}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </section>
              </div>

              {/* Right: the live instrument and the correction control */}
              <aside className="flex min-w-0 flex-col gap-5 max-lg:order-first" aria-label="Vessel">
                <section
                  aria-labelledby="console-title"
                  className="panel min-w-0 px-4 pb-3 sm:px-5 [&_li:last-child]:border-b-0"
                >
                  <h2
                    id="console-title"
                    className="panel-title -mx-4 border-b border-sea-rule px-4 py-3.5 sm:-mx-5 sm:px-5"
                  >
                    Vessel and live position
                  </h2>
                  {!shipment.vessel_mmsi ? (
                    <div className="border-b border-sea-rule-2 py-4">
                      <p className="text-[13px] font-medium text-sea-ink">Not tracked on AIS</p>
                      <p className="mt-1 text-[12.5px] leading-[1.5] text-sea-ink-2">
                        Without an MMSI this voyage is followed by schedule only: no position, no
                        automatic phase changes.
                      </p>
                      <button
                        type="button"
                        className={`${btnGhost} mt-3`}
                        onClick={() => setEditOpen(true)}
                      >
                        Add vessel MMSI
                      </button>
                    </div>
                  ) : !position ? (
                    <div className="border-b border-sea-rule-2 py-4">
                      <p className="text-[13px] font-medium text-sea-ink">Awaiting first AIS fix</p>
                      <p className="mt-1 text-[12.5px] leading-[1.5] text-sea-ink-2">
                        Listening for MMSI{" "}
                        <span className="telemetry text-[11px]">{shipment.vessel_mmsi}</span>. A
                        position is recorded when the vessel next transmits in range of a receiver.
                        If none arrives, check the MMSI against the booking.
                      </p>
                    </div>
                  ) : (
                    <div className="console mt-3 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <span className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-nav-foreground">
                          <span
                            className={`relative inline-block size-1.5 rounded-full ${hasFreshAis ? "ping-live bg-nav-accent text-nav-accent" : "bg-sea-amber"}`}
                            aria-hidden
                          />
                          {hasFreshAis ? "Live" : "Last known"}
                        </span>
                        <span className="telemetry text-[10.5px] uppercase text-nav-muted-foreground">
                          {utcDayTime(position.position_timestamp ?? position.updated_at, now)} UTC
                        </span>
                      </div>
                      <p className="telemetry mt-3 text-[13px] text-nav-foreground">
                        {formatCoordinates(position.latitude, position.longitude)}
                      </p>
                      <div className="mt-4 flex items-center gap-5">
                        <CompassRose cog={position.cog} />
                        <div className="grid flex-1 grid-cols-2 gap-4">
                          <ConsoleSpeed sog={position.sog} />
                          <ConsoleField
                            label="COG"
                            value={
                              position.cog != null
                                ? `${String(Math.round(position.cog)).padStart(3, "0")}°`
                                : "None"
                            }
                          />
                          <div className="col-span-2">
                            <ConsoleField
                              label="Nav status"
                              value={navStatusLabel(position.nav_status)}
                            />
                          </div>
                        </div>
                      </div>
                      {!hasFreshAis ? (
                        <p className="mt-4 border-t border-nav-border pt-3 text-[12px] leading-[1.45] text-sea-amber">
                          Position is over 24 hours old. The vessel may be out of receiver range;
                          phase automation will not act on it.
                        </p>
                      ) : conditionLabel ? (
                        <p className="mt-4 border-t border-nav-border pt-3 text-[12px] text-nav-muted-foreground">
                          {conditionLabel}
                        </p>
                      ) : null}
                    </div>
                  )}
                  {shipment.vessel_mmsi ? (
                    <Link
                      to="/map"
                      className="focus-ring mt-2 inline-flex items-center gap-1 rounded-sm text-[12.5px] font-medium text-ww-blue hover:text-ww-blue-hover"
                    >
                      Fleet map <ArrowRight className="size-3" aria-hidden />
                    </Link>
                  ) : null}
                </section>

                <section
                  aria-labelledby="override-title"
                  className="panel min-w-0 px-4 pb-3 sm:px-5 [&_li:last-child]:border-b-0"
                >
                  <h2
                    id="override-title"
                    className="panel-title -mx-4 border-b border-sea-rule px-4 py-3.5 sm:-mx-5 sm:px-5"
                  >
                    Correct the phase
                  </h2>
                  {legacyTerminal ? (
                    <p className="py-3 text-[12.5px] text-sea-ink-3">
                      This record holds a legacy status ({shipment.status}) retired from the active
                      lifecycle, so it cannot be corrected here.
                    </p>
                  ) : !overrideOpen ? (
                    <div className="flex items-center justify-between gap-3 py-3">
                      <p className="text-[12.5px] leading-[1.45] text-sea-ink-3">
                        For a wrong AIS reading or an accidental change. Logged as an operator entry
                        and holds automation.
                      </p>
                      <button
                        type="button"
                        onClick={openOverride}
                        className={`${btnGhost} shrink-0`}
                      >
                        Override
                      </button>
                    </div>
                  ) : (
                    <div className="animate-in space-y-3 py-3">
                      <label className="block">
                        <span className="label-xs mb-1 block">New phase</span>
                        <select
                          className={fieldClass}
                          value={overrideStatus}
                          onChange={(e) =>
                            setOverrideStatus(e.target.value as ActiveShipmentStatus)
                          }
                        >
                          {ACTIVE_STATUSES.map((st) => (
                            <option key={st} value={st}>
                              {st}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="block">
                        <span className="label-xs mb-1 block">Reason</span>
                        <textarea
                          className={`${fieldClass} min-h-[60px] resize-y py-1.5`}
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
              </aside>
            </div>
          ) : null}

          {tab === "timeline" ? (
            <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
              <ShipmentTimeline shipment={shipment} events={events} />
              <StatusHistory events={events} />
            </div>
          ) : null}

          {tab === "documents" ? <DocumentFiles shipmentId={id} documents={documents} /> : null}

          {tab === "notes" ? <ShipmentNotes shipmentId={id} /> : null}

          {tab === "alerts" ? (
            <section
              aria-labelledby="signals-title"
              className="panel min-w-0 px-4 pb-3 sm:px-5 [&_li:last-child]:border-b-0"
            >
              <div className="-mx-4 flex min-h-[52px] flex-wrap items-center justify-between gap-2 border-b border-sea-rule px-4 py-2.5 sm:-mx-5 sm:px-5">
                <h2 id="signals-title" className="panel-title">
                  Signals
                  <span className="telemetry ml-2 font-normal normal-case tracking-normal text-sea-ink-3">
                    {shipmentAlerts.length} on this voyage, UTC
                  </span>
                </h2>
                <span className="text-[12px] text-sea-ink-2">
                  Current state:{" "}
                  <span
                    className={
                      level === "alarm"
                        ? "text-sea-red"
                        : level
                          ? "text-sea-amber-ink"
                          : "text-sea-ink"
                    }
                  >
                    {health.level}
                  </span>
                  {level ? `. ${health.action ?? "Review the voyage"}` : ""}
                </span>
              </div>
              {shipmentAlerts.length === 0 ? (
                <div className="py-5">
                  <p className="text-[13px] font-medium text-sea-ink">No signals on this voyage</p>
                  <p className="mt-1 max-w-[60ch] text-[12.5px] text-sea-ink-2">
                    ETA revisions, departures and phase changes that need a look are raised here,
                    most recent first.
                  </p>
                </div>
              ) : (
                <ol>
                  {shipmentAlerts.map((a) => {
                    const severity = alertSeverity(a);
                    return (
                      <li
                        key={a.id}
                        className="animate-in grid grid-cols-[88px_minmax(0,1fr)] gap-x-4 gap-y-1 border-b border-sea-rule-2 py-3 sm:grid-cols-[112px_104px_minmax(0,1fr)_auto]"
                      >
                        <span className="self-start pt-0.5">
                          <SeverityBadge severity={severity} label={SEVERITY_LABEL[severity]} />
                        </span>
                        <time className="telemetry self-start pt-px text-[10.5px] uppercase text-sea-ink-2 sm:order-none">
                          {utcDayTime(a.created_at, now)}
                        </time>
                        <span className="col-span-2 text-[13.5px] text-sea-ink sm:col-span-1">
                          {a.message}
                        </span>
                        <span className="col-span-2 flex items-center gap-1.5 sm:col-span-1 sm:justify-end">
                          {a.from_status ? <StatusPill status={a.from_status} /> : null}
                          {a.from_status && a.to_status ? (
                            <span className="text-[12px] text-sea-ink-4">→</span>
                          ) : null}
                          {a.to_status ? <StatusPill status={a.to_status} /> : null}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>
          ) : null}
        </div>
      </div>
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
        className="focus-ring grid size-8 place-items-center rounded-md border border-sea-rule bg-sea-surface text-sea-ink-2 transition-colors hover:bg-sea-paper-2 hover:text-sea-ink"
        aria-label="More actions"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal className="size-4" />
      </button>
      {open ? (
        <div className="panel-lifted animate-in absolute right-0 z-20 mt-1.5 w-52 overflow-hidden py-1">
          {next ? (
            <button
              type="button"
              className="block w-full px-3 py-2 text-left text-[13px] text-sea-ink transition-colors hover:bg-sea-paper-2 disabled:opacity-50"
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
            className="block w-full border-t border-sea-rule-2 px-3 py-2 text-left text-[13px] text-sea-red transition-colors hover:bg-sea-red-soft"
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

/** One reading in the record header strip: condensed label, the value at
 * reading size, and a quieter line of context under it. */
function HeaderStat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 border-sea-rule-2 py-3 pr-4 [&:not(:first-child)]:pl-4 [&:not(:first-child)]:border-l max-sm:[&:nth-child(odd)]:border-l-0 max-sm:[&:nth-child(odd)]:pl-0 max-sm:[&:nth-child(n+3)]:border-t max-sm:[&:last-child]:col-span-2 sm:max-lg:[&:nth-child(3n+1)]:border-l-0 sm:max-lg:[&:nth-child(3n+1)]:pl-0 sm:max-lg:[&:nth-child(n+4)]:border-t">
      <dt className="text-[12px] font-medium text-sea-ink-3">{label}</dt>
      <dd className="mt-1 flex min-w-0 flex-col text-[15px] font-medium leading-[21px] text-sea-ink">
        {children}
      </dd>
    </div>
  );
}

function HeaderSub({ children, mono = false }: { children: ReactNode; mono?: boolean }) {
  return (
    <span
      className={`mt-0.5 block truncate font-normal text-sea-ink-3 ${mono ? "telemetry text-[10.5px] uppercase leading-[16px]" : "text-[12px] leading-[16px]"}`}
    >
      {children}
    </span>
  );
}

/** A field inside the console — the dark, live register. Label in small
 * caps, value in instrument mono, both tuned for the nav palette rather
 * than the page's light "business" colours. */
function ConsoleField({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="chart-label text-nav-muted-foreground">{label}</p>
      <p className="telemetry mt-1 truncate text-[14px] text-nav-foreground">{value}</p>
    </div>
  );
}

/** Speed over ground as an instrument, not just a number: a bounded
 * gauge (0–28kn, the range that covers virtually every cargo
 * vessel) makes "fast" or "slow" legible at a glance. */
function ConsoleSpeed({ sog }: { sog: number | null }) {
  const pct = sog != null ? Math.max(0, Math.min(100, (sog / 28) * 100)) : 0;
  return (
    <div className="min-w-0">
      <p className="chart-label text-nav-muted-foreground">SOG</p>
      <p className="telemetry mt-1 truncate text-[14px] text-nav-foreground">
        {sog != null ? `${sog.toFixed(1)} KN` : "None"}
      </p>
      <div className="mt-2 h-[2px] w-full bg-nav-border">
        <div
          className="h-full bg-nav-accent transition-[width] duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/** Course over ground as a heading on an actual compass face, not just a
 * number — a fixed ring of cardinal points with a needle that rotates to
 * the vessel's real bearing (0° = north, clockwise). The one place this
 * interface borrows a literal nautical instrument, because here it's
 * doing real work: showing direction of travel at a glance. */
function CompassRose({ cog }: { cog: number | null }) {
  return (
    <div
      className="relative grid size-14 shrink-0 place-items-center rounded-full border border-nav-border"
      role="img"
      aria-label={cog != null ? `Heading ${cog} degrees` : "Heading unknown"}
    >
      <span className="absolute top-1 text-[8px] font-semibold text-nav-muted-foreground">N</span>
      <span className="absolute bottom-1 text-[8px] text-nav-muted-foreground/50">S</span>
      <span className="absolute left-1.5 text-[8px] text-nav-muted-foreground/50">W</span>
      <span className="absolute right-1.5 text-[8px] text-nav-muted-foreground/50">E</span>
      <svg
        viewBox="0 0 56 56"
        className={`size-full transition-transform duration-700 ease-[cubic-bezier(0.16,1,0.3,1)] ${cog == null ? "opacity-30" : ""}`}
        style={{ transform: `rotate(${cog ?? 0}deg)` }}
        aria-hidden
      >
        <line
          x1="28"
          y1="10"
          x2="28"
          y2="28"
          stroke="var(--color-nav-accent)"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <line
          x1="28"
          y1="28"
          x2="28"
          y2="42"
          stroke="var(--color-nav-muted-foreground)"
          strokeWidth="1.5"
          strokeLinecap="round"
          opacity="0.5"
        />
        <circle cx="28" cy="28" r="2.5" fill="var(--color-nav-accent)" />
      </svg>
    </div>
  );
}

/** The lifecycle as a measured passage rather than a stepper: three
 * stretches (port, sea, port), each phase a division on the line, the
 * phases reached drawn solid with the time they were reached (UTC, from
 * the voyage log), the present phase marked, the rest ahead as hairline. */
function LifecycleJourney({
  status,
  legacyTerminal,
  currentIndex,
  reachedAt,
}: {
  status: string;
  legacyTerminal: boolean;
  currentIndex: number;
  reachedAt: (phase: string) => string | null;
}) {
  const groups: { label: string; phases: number[] }[] = [
    { label: "Port of loading", phases: [0, 1] },
    { label: "At sea", phases: [2, 3, 4] },
    { label: "Port of discharge", phases: [5] },
  ];
  return (
    <div className="pt-4">
      <ol className="grid grid-cols-1 gap-y-4 sm:grid-cols-[2fr_3fr_1fr] sm:gap-x-2">
        {groups.map((g) => (
          <li key={g.label} className="min-w-0">
            <span className="chart-label block truncate !text-[9.5px] text-sea-ink-4">
              {g.label}
            </span>
            <ol
              className="mt-2 grid"
              style={{ gridTemplateColumns: `repeat(${g.phases.length}, minmax(0, 1fr))` }}
            >
              {g.phases.map((i) => {
                const phase = ACTIVE_STATUSES[i]!;
                const done = legacyTerminal || i < currentIndex;
                const current = !legacyTerminal && i === currentIndex;
                const arrived = phase === "Arrived" && (current || legacyTerminal);
                const at = reachedAt(phase);
                return (
                  <li key={phase} className="min-w-0 pr-2">
                    <span
                      aria-hidden
                      className={`block rounded-full ${current || arrived ? "h-[5px]" : "h-[3px]"} ${
                        arrived
                          ? "bg-sea-green"
                          : current
                            ? "bg-ww-blue"
                            : done
                              ? "bg-ww-steel/70"
                              : "bg-sea-rule"
                      }`}
                    />
                    <span
                      className={`mt-2 block truncate text-[12.5px] leading-tight ${
                        current
                          ? "font-semibold text-sea-ink"
                          : done
                            ? "text-sea-ink-2"
                            : "text-sea-ink-4"
                      }`}
                    >
                      {phase === "Approaching Destination" ? "Approaching" : phase}
                    </span>
                    <span className="telemetry mt-0.5 block truncate text-[10px] uppercase text-sea-ink-3">
                      {at ? utcDayTime(at) : current ? "Now" : ""}
                    </span>
                  </li>
                );
              })}
            </ol>
          </li>
        ))}
      </ol>
      {legacyTerminal ? (
        <p className="mt-3 text-[12px] text-sea-ink-3">
          This record holds a legacy status ({status}), retired from the active lifecycle.
        </p>
      ) : null}
    </div>
  );
}

function InfoField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="label-xs mb-1 block">{label}</span>
      <span className="text-[13px] text-sea-ink-2">{value}</span>
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
