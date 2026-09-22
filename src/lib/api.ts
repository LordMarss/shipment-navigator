import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

/**
 * Any Supabase client the shared helpers can write through. The browser client
 * is the default; the scheduled server-side runner passes the admin client.
 */
export type Db = SupabaseClient<Database>;


/**
 * Lifecycle position of a shipment. This says WHERE the shipment is — never
 * how well it is doing (that is `health`, see lib/lifecycle.ts).
 *
 * MVP scope is AIS-focused: a shipment only ever moves through these six
 * statuses, driven by vessel movement (actual departure/arrival) and the
 * monitoring window derived from origin/destination timing. No carrier,
 * customs or delivery workflow is modeled yet.
 */
export const ACTIVE_STATUSES = [
  "Scheduled",
  "Booked",
  "Departed",
  "In Transit",
  "Approaching Destination",
  "Arrived",
] as const;

/**
 * Retired from the active MVP lifecycle. Never assigned to new shipments or
 * by automation — kept only so existing records and their historical events
 * (and the `shipment_status` database enum, which cannot drop values in use)
 * stay valid and correctly typed.
 */
export const LEGACY_STATUSES = ["At Port", "Cleared Customs", "Delivered"] as const;

/** Full set, matching the database enum exactly. */
export const STATUSES = [...ACTIVE_STATUSES, ...LEGACY_STATUSES] as const;

export type ActiveShipmentStatus = (typeof ACTIVE_STATUSES)[number];
export type ShipmentStatus = (typeof STATUSES)[number];

export function isLegacyStatus(status: ShipmentStatus): boolean {
  return (LEGACY_STATUSES as readonly string[]).includes(status);
}

export const HEALTH_LEVELS = ["On Track", "Attention", "At Risk", "Delayed"] as const;
export type HealthValue = (typeof HEALTH_LEVELS)[number];

export const MONITORING_STATES = [
  "Scheduled",
  "Pre-Monitoring",
  "Active Monitoring",
  "Completed",
] as const;
export type MonitoringState = (typeof MONITORING_STATES)[number];

export type EventSource = "manual" | "ais" | "system";

export type Shipment = {
  id: string;
  client_name: string;
  origin: string;
  destination: string;
  vessel_name: string | null;
  vessel_mmsi: string | null;
  vessel_imo: string | null;
  landed_cost: number | null;
  /** Structured port reference, optional — free-text origin/destination
   * above remain the source of truth for display; these only enable
   * destination-aware AIS geofencing. Null for any shipment created before
   * this field existed, or whose port isn't in the seeded dataset. */
  origin_port_id: string | null;
  destination_port_id: string | null;
  status: ShipmentStatus;
  /** Current/latest ETA. `planned_eta` holds the original estimate. */
  eta: string | null;
  previous_eta: string | null;
  planned_etd: string | null;
  planned_eta: string | null;
  actual_departure: string | null;
  actual_arrival: string | null;
  actual_delivery: string | null;
  /** Stored health, maintained by backend automation. */
  health: HealthValue | string;
  health_reason: string | null;
  monitoring_state: MonitoringState | string;
  /** Per-shipment override of the workspace monitoring offset. */
  monitoring_start_offset_days: number | null;
  /** AIS debounce state (Phase 3) — the status a fresh AIS reading is currently proposing, and since when. */
  ais_pending_status: ShipmentStatus | null;
  ais_pending_since: string | null;
  /** While in the future, automation stands down: an operator has just corrected this shipment's status. May be absent until the Phase 2 migration is applied. */
  automation_hold_until?: string | null;
  reference: string | null;
  carrier: string | null;
  container_number: string | null;
  customer_reference: string | null;
  last_synced_at: string | null;
  updated_at: string;
  created_at: string;
};

/** Lifecycle timeline + audit trail record. Never fabricated on the client. */
export type ShipmentEvent = {
  id: string;
  shipment_id: string;
  event_type: string;
  /** "event" | "status" | "health" | "eta" | "note" */
  category: string;
  occurred_at: string;
  field: string | null;
  from_value: string | null;
  to_value: string | null;
  source: EventSource | string;
  automated: boolean;
  actor: string | null;
  reason: string | null;
  created_at: string;
};

export type ShipmentDocument = {
  id: string;
  shipment_id: string;
  name: string;
  done: boolean;
  is_standard: boolean;
  file_path: string | null;
  file_url: string | null;
  file_name: string | null;
  file_type: string | null;
  uploaded_at: string | null;
};

export const DOCS_BUCKET = "shipment-documents";
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const ACCEPTED_FILE_TYPES = ".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png";

function fileKind(file: File) {
  if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) return "pdf";
  if (file.type.startsWith("image/")) return "image";
  return "file";
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDate(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

async function removeStoredFile(path: string | null) {
  if (!path) return;
  await supabase.storage.from(DOCS_BUCKET).remove([path]);
}

export async function uploadDocumentFile(doc: ShipmentDocument, file: File) {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`${file.name} is ${formatBytes(file.size)} — the limit is 10 MB per file.`);
  }
  const kind = fileKind(file);
  if (kind === "file") {
    throw new Error("Only PDF, JPG and PNG files are supported.");
  }
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `${doc.shipment_id}/${doc.id}-${Date.now()}-${safeName}`;
  const { error: uploadError } = await supabase.storage
    .from(DOCS_BUCKET)
    .upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false });
  if (uploadError) throw uploadError;

  const previousPath = doc.file_path;
  const { error } = await supabase
    .from("documents")
    .update({
      file_path: path,
      file_url: path,
      file_name: file.name,
      file_type: kind,
      uploaded_at: new Date().toISOString(),
      done: true,
    })
    .eq("id", doc.id);
  if (error) {
    await removeStoredFile(path);
    throw error;
  }
  await removeStoredFile(previousPath && previousPath !== path ? previousPath : null);
}

export async function clearDocumentFile(doc: ShipmentDocument) {
  const { error } = await supabase
    .from("documents")
    .update({
      file_path: null,
      file_url: null,
      file_name: null,
      file_type: null,
      uploaded_at: null,
      done: false,
    })
    .eq("id", doc.id);
  if (error) throw error;
  await removeStoredFile(doc.file_path);
}

export async function createOtherDocument(shipmentId: string, file: File) {
  const { data, error } = await supabase
    .from("documents")
    .insert({ shipment_id: shipmentId, name: file.name, done: false, is_standard: false })
    .select("*")
    .single();
  if (error) throw error;
  try {
    await uploadDocumentFile(data as ShipmentDocument, file);
  } catch (e) {
    await supabase.from("documents").delete().eq("id", (data as ShipmentDocument).id);
    throw e;
  }
}

export async function deleteDocument(doc: ShipmentDocument) {
  const { error } = await supabase.from("documents").delete().eq("id", doc.id);
  if (error) throw error;
  await removeStoredFile(doc.file_path);
}

export async function getDocumentUrl(doc: ShipmentDocument) {
  if (!doc.file_path) throw new Error("No file attached.");
  const { data, error } = await supabase.storage
    .from(DOCS_BUCKET)
    .createSignedUrl(doc.file_path, 60 * 10);
  if (error) throw error;
  return data.signedUrl;
}

export type Alert = {
  id: string;
  shipment_id: string | null;
  message: string;
  from_status: ShipmentStatus | null;
  to_status: ShipmentStatus | null;
  created_at: string;
};

export const STANDARD_DOCUMENTS = [
  "Bill of Lading",
  "Commercial Invoice",
  "Certificate of Origin",
  "Packing List",
];

/** Advances only within the active MVP lifecycle; legacy/terminal statuses never advance. */
export function nextStatus(status: ShipmentStatus): ShipmentStatus | null {
  const i = ACTIVE_STATUSES.indexOf(status as ActiveShipmentStatus);
  return i >= 0 && i < ACTIVE_STATUSES.length - 1 ? ACTIVE_STATUSES[i + 1]! : null;
}

export function shortId(id: string) {
  return `SHP-${id.slice(0, 6).toUpperCase()}`;
}

export function formatCost(value: number | null) {
  if (value == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

export async function listShipments() {
  const { data, error } = await supabase
    .from("shipments")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as Shipment[];
}

export async function getShipment(id: string) {
  const { data, error } = await supabase.from("shipments").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return (data as Shipment | null) ?? null;
}

/**
 * Latest known AIS position for a vessel, written by the standalone AIS
 * ingestion worker (scripts/ais-listener.ts). Read-only here — this goes
 * through the same anon-key + RLS path as every other read in this file,
 * never the service-role key, which stays server-side in the worker.
 */
export type VesselPosition = {
  mmsi: string;
  vessel_name: string | null;
  latitude: number;
  longitude: number;
  sog: number | null;
  cog: number | null;
  true_heading: number | null;
  nav_status: string | null;
  position_timestamp: string | null;
  received_at: string;
  source: string;
  updated_at: string;
};

/**
 * Latest AIS position for a shipment's vessel, or null if it has no MMSI or
 * none has been received yet. Defaults to the browser anon-key client (the
 * original client-side use case); server code passes the admin client
 * explicitly, same pattern as `updateShipment`.
 */
export async function getVesselPositionForShipment(
  shipment: Pick<Shipment, "vessel_mmsi">,
  db: Db = supabase,
): Promise<VesselPosition | null> {
  if (!shipment.vessel_mmsi) return null;
  const { data, error } = await db
    .from("vessel_positions")
    .select("*")
    .eq("mmsi", shipment.vessel_mmsi)
    .maybeSingle();
  if (error) throw error;
  return (data as VesselPosition | null) ?? null;
}

/**
 * Latest AIS positions for a set of vessels in one query, keyed by MMSI —
 * the batch counterpart to `getVesselPositionForShipment`, used wherever a
 * page needs live telemetry for many shipments at once (the dashboard's
 * fleet status, an operational table) without one query per row.
 */
export async function listVesselPositionsByMmsi(
  mmsis: string[],
  db: Db = supabase,
): Promise<Map<string, VesselPosition>> {
  const unique = Array.from(new Set(mmsis.filter(Boolean)));
  if (unique.length === 0) return new Map();
  const { data, error } = await db.from("vessel_positions").select("*").in("mmsi", unique);
  if (error) throw error;
  return new Map((data as VesselPosition[]).map((p) => [p.mmsi, p]));
}

/**
 * Structured port reference data (seeded, MVP-accurate coordinates — see
 * the migration for sourcing notes). Read-only from the client; nothing
 * here writes to `ports`.
 */
export type Port = {
  id: string;
  name: string;
  unlocode: string | null;
  country: string | null;
  latitude: number;
  longitude: number;
  geofence_radius_km: number;
  /** Coarse category derived from the source data (container/cargo/terminal/
   * fishing/ferry/military/general) — never guessed beyond what the source
   * actually states; 'general' means the source gave no strong signal. */
  port_type: string;
  /** Where this row's data comes from — 'nga_wpi' (NGA World Port Index) or
   * 'manual_seed' (the original hand-curated seed, for the handful of major
   * ports the automated import couldn't confidently match/improve). */
  source: string;
  /** Natural key back to the source record (e.g. a WPI row id) — lets a
   * re-import upsert instead of duplicating. Null for hand-seeded rows. */
  source_identifier: string | null;
  /** Soft-disable flag: a bad/duplicate port can be retired without
   * deleting it, which would break any shipment still referencing it. */
  active: boolean;
  created_at: string;
  updated_at: string;
};

/** Full port list — used rarely (there is no current admin/listing UI for
 * it); the shipment-creation path uses `searchPorts` instead so it never
 * has to load the whole table. */
export async function listPorts(db: Db = supabase) {
  const { data, error } = await db.from("ports").select("*").eq("active", true).order("name");
  if (error) throw error;
  return (data ?? []) as Port[];
}

export async function getPortById(id: string, db: Db = supabase): Promise<Port | null> {
  const { data, error } = await db.from("ports").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return (data as Port | null) ?? null;
}

/**
 * Server-side port search for the autocomplete — with a few thousand ports
 * (and growing), filtering a client-side copy of the whole table on every
 * keystroke stops being the right approach. Matches name, UN/LOCODE or
 * country, active ports only, ranked by name.
 */
export async function searchPorts(term: string, limit = 8, db: Db = supabase): Promise<Port[]> {
  const trimmed = term.trim();
  if (!trimmed) return [];
  // `.or()` filter values are comma-separated, so a literal comma in the
  // search term would otherwise break the filter's own syntax.
  const safe = trimmed.replace(/[,()%]/g, " ").trim();
  if (!safe) return [];
  const pattern = `%${safe}%`;
  const { data, error } = await db
    .from("ports")
    .select("*")
    .eq("active", true)
    .or(`name.ilike.${pattern},unlocode.ilike.${pattern},country.ilike.${pattern}`)
    .order("name")
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as Port[];
}

export async function listDocuments(shipmentId: string) {
  const { data, error } = await supabase
    .from("documents")
    .select("*")
    .eq("shipment_id", shipmentId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as ShipmentDocument[];
}

export async function listAlerts() {
  const { data, error } = await supabase
    .from("alerts")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data ?? []) as Alert[];
}

export async function logAlert(
  input: {
    shipment_id: string;
    message: string;
    from_status?: ShipmentStatus | null;
    to_status?: ShipmentStatus | null;
  },
  db: Db = supabase,
) {
  const { error } = await db.from("alerts").insert({
    shipment_id: input.shipment_id,
    message: input.message,
    from_status: input.from_status ?? null,
    to_status: input.to_status ?? null,
  });
  if (error) throw error;
}

export async function createShipment(input: {
  client_name: string;
  origin: string;
  destination: string;
  origin_port_id?: string | null;
  destination_port_id?: string | null;
  vessel_name: string | null;
  vessel_mmsi: string | null;
  landed_cost: number | null;
  eta?: string | null;
  planned_etd?: string | null;
  planned_eta?: string | null;
}) {
  const plannedEtd = input.planned_etd ?? null;
  const plannedEta = input.planned_eta ?? null;
  // Planned and current values are stored separately so automation can update
  // the current ETA later without losing the original plan.
  const { data, error } = await supabase
    .from("shipments")
    .insert({
      ...input,
      planned_etd: plannedEtd,
      planned_eta: plannedEta,
      eta: input.eta ?? plannedEta,
      status: "Booked",
      last_synced_at: new Date().toISOString(),
    })
    .select("*")
    .single();
  if (error) throw error;
  const shipment = data as Shipment;

  const { error: docError } = await supabase
    .from("documents")
    .insert(
      STANDARD_DOCUMENTS.map((name) => ({
        shipment_id: shipment.id,
        name,
        done: false,
        is_standard: true,
      })),
    );
  if (docError) throw docError;

  await logAlert({
    shipment_id: shipment.id,
    message: `Shipment created for ${shipment.client_name} (${shipment.origin} → ${shipment.destination})`,
    to_status: "Booked",
  });

  return shipment;
}

export async function updateShipment(id: string, patch: Partial<Shipment>, db: Db = supabase) {
  const { error } = await db.from("shipments").update(patch).eq("id", id);
  if (error) throw error;
}

/** Manual status advance — preserved as the fallback for the automation. */
export async function advanceStatus(shipment: Shipment, db: Db = supabase) {
  const to = nextStatus(shipment.status);
  if (!to) return;
  // Applied only if the shipment is still in the status this page showed, so a
  // stale page can never regress a shipment automation has since moved.
  const result = await applyManualStatusChange({
    shipmentId: shipment.id,
    newStatus: to,
    expectedStatus: shipment.status,
    eventType: "status_manual",
    reason: null,
    alertMessage: `${shortId(shipment.id)} · ${shipment.client_name} moved to ${to}`,
  }, db);
  if (result.outcome === "conflict") {
    throw new Error("This shipment's status changed since the page loaded. Refresh and try again.");
  }
}

export async function deleteShipment(id: string) {
  const { error } = await supabase.from("shipments").delete().eq("id", id);
  if (error) throw error;
}

export async function listAllDocuments() {
  const { data, error } = await supabase
    .from("documents")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as ShipmentDocument[];
}

export function formatEta(value: string | null) {
  if (!value) return "Not set";
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Saves editable shipment fields. When the ETA changes, the previous value is
 * retained on the record and the change is logged to the alerts feed.
 */
export async function saveShipmentEdits(
  shipment: Shipment,
  patch: {
    client_name: string;
    origin: string;
    destination: string;
    vessel_name: string | null;
    vessel_mmsi: string | null;
    landed_cost: number | null;
    eta: string | null;
  },
) {
  const etaChanged = (patch.eta ?? null) !== (shipment.eta ?? null);
  await updateShipment(shipment.id, {
    ...patch,
    ...(etaChanged ? { previous_eta: shipment.eta } : {}),
  });

  if (etaChanged && shipment.eta && patch.eta) {
    const hours = Math.round(
      (new Date(patch.eta).getTime() - new Date(shipment.eta).getTime()) / 3_600_000,
    );
    const direction = hours >= 0 ? "later" : "earlier";
    await logAlert({
      shipment_id: shipment.id,
      message: `ETA changed by ${Math.abs(hours)} hours ${direction}`,
    });
  } else if (etaChanged && patch.eta) {
    await logAlert({ shipment_id: shipment.id, message: `ETA set to ${formatEta(patch.eta)}` });
  }
}

/* ------------------------------------------------- lifecycle events + audit */

export async function listEvents(shipmentId: string) {
  const { data, error } = await supabase
    .from("shipment_events")
    .select("*")
    .eq("shipment_id", shipmentId)
    .order("occurred_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as ShipmentEvent[];
}

export async function listAllEvents(limit = 20) {
  const { data, error } = await supabase
    .from("shipment_events")
    .select("*")
    .order("occurred_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as ShipmentEvent[];
}

export async function recordEvent(
  input: {
    shipment_id: string;
    event_type: string;
    category?: string;
    field?: string | null;
    from_value?: string | null;
    to_value?: string | null;
    source?: EventSource;
    automated?: boolean;
    actor?: string | null;
    reason?: string | null;
    occurred_at?: string;
  },
  db: Db = supabase,
) {
  const { error } = await db.from("shipment_events").insert({
    shipment_id: input.shipment_id,
    event_type: input.event_type,
    category: input.category ?? "event",
    field: input.field ?? null,
    from_value: input.from_value ?? null,
    to_value: input.to_value ?? null,
    source: input.source ?? "manual",
    automated: input.automated ?? false,
    actor: input.actor ?? "Operator",
    reason: input.reason ?? null,
    occurred_at: input.occurred_at ?? new Date().toISOString(),
  });
  if (error) throw error;
}

/* --------------------------------------------------------- workspace config */

export const SETTING_KEYS = [
  "monitoring_start_offset_days",
  "pre_monitoring_window_days",
  "eta_attention_hours",
  "eta_risk_hours",
  "ais_lifecycle_fresh_minutes",
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

export async function listSettings() {
  const { data, error } = await supabase.from("app_settings").select("key, value");
  if (error) throw error;
  const out: Record<string, number> = {};
  for (const row of data ?? []) {
    const n = Number(row.value as unknown as number);
    if (!Number.isNaN(n)) out[row.key] = n;
  }
  return out;
}

export async function updateSetting(key: SettingKey, value: number) {
  const { error } = await supabase
    .from("app_settings")
    .upsert({ key, value: value as unknown as never }, { onConflict: "key" });
  if (error) throw error;
}

/* ------------------------------------------------------ temporal edit + log */

export type TemporalPatch = {
  planned_etd: string | null;
  planned_eta: string | null;
  eta: string | null;
  actual_departure: string | null;
  actual_arrival: string | null;
  actual_delivery: string | null;
};

const TEMPORAL_LABELS: Record<keyof TemporalPatch, string> = {
  planned_etd: "Planned departure",
  planned_eta: "Planned arrival",
  eta: "Current ETA",
  actual_departure: "Actual departure",
  actual_arrival: "Actual arrival",
  actual_delivery: "Actual delivery",
};

/**
 * Saves the editable shipment fields (details + every date) and records one
 * audit event per changed field so the change is always attributable.
 */
export async function saveShipmentDetails(
  shipment: Shipment,
  patch: Partial<Shipment>,
  reason?: string | null,
  db: Db = supabase,
) {
  // A status change is an operator decision about the lifecycle. It goes through
  // the same atomic path as advance/override — clearing pending AIS evidence,
  // holding automation after a backward correction — not through the generic
  // field update below.
  const { status: newStatus, ...fieldPatch } = patch;

  const changed = Object.entries(fieldPatch).filter(
    ([k, v]) => (v ?? null) !== ((shipment as Record<string, unknown>)[k] ?? null),
  );

  if (changed.length > 0) {
    const etaChanged = changed.some(([k]) => k === "eta");
    await updateShipment(shipment.id, {
      ...fieldPatch,
      ...(etaChanged ? { previous_eta: shipment.eta } : {}),
    }, db);

    for (const [field, value] of changed) {
      const label = TEMPORAL_LABELS[field as keyof TemporalPatch] ?? field.replace(/_/g, " ");
      await recordEvent({
        shipment_id: shipment.id,
        event_type: field,
        category: field in TEMPORAL_LABELS ? "eta" : "event",
        field: label,
        from_value: formatEventValue((shipment as Record<string, unknown>)[field]),
        to_value: formatEventValue(value),
        source: "manual",
        automated: false,
        reason: reason ?? null,
      }, db);
    }

    if (etaChanged) {
      const to = (fieldPatch.eta as string | null) ?? null;
      if (shipment.eta && to) {
        const hours = Math.round(
          (new Date(to).getTime() - new Date(shipment.eta).getTime()) / 3_600_000,
        );
        await logAlert({
          shipment_id: shipment.id,
          message: `ETA changed by ${Math.abs(hours)} hours ${hours >= 0 ? "later" : "earlier"}`,
        }, db);
      } else if (to) {
        await logAlert({ shipment_id: shipment.id, message: `ETA set to ${formatEta(to)}` }, db);
      }
    }
  }

  if (newStatus !== undefined && newStatus !== shipment.status) {
    await overrideStatus(shipment, newStatus, reason, db);
  }
}

function formatEventValue(value: unknown) {
  if (value == null || value === "") return null;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return new Date(value).toISOString();
  }
  return String(value);
}

/** Manual override of the derived health, always with a reason. */
export async function overrideHealth(shipment: Shipment, health: HealthValue, reason: string) {
  await updateShipment(shipment.id, { health, health_reason: reason });
  await recordEvent({
    shipment_id: shipment.id,
    event_type: "health_override",
    category: "health",
    field: "Health",
    from_value: String(shipment.health),
    to_value: health,
    source: "manual",
    automated: false,
    reason,
  });
  await logAlert({
    shipment_id: shipment.id,
    message: `${shortId(shipment.id)} health set to ${health} — ${reason}`,
  });
}

/** Manual override of the monitoring state, always with a reason. */
export async function overrideMonitoring(
  shipment: Shipment,
  state: MonitoringState,
  reason: string,
) {
  await updateShipment(shipment.id, { monitoring_state: state });
  await recordEvent({
    shipment_id: shipment.id,
    event_type: "monitoring_override",
    category: "monitoring",
    field: "Monitoring state",
    from_value: String(shipment.monitoring_state),
    to_value: state,
    source: "manual",
    automated: false,
    reason,
  });
}

/** Bulk insert foundation used by the import wizard. */
export type ImportRow = {
  client_name: string;
  origin: string;
  destination: string;
  vessel_name: string | null;
  vessel_mmsi: string | null;
  carrier: string | null;
  reference: string | null;
  container_number: string | null;
  planned_etd: string | null;
  planned_eta: string | null;
  landed_cost: number | null;
};

export async function importShipments(rows: ImportRow[]) {
  const { data, error } = await supabase
    .from("shipments")
    .insert(rows.map((r) => ({ ...r, eta: r.planned_eta, status: "Booked" as const })))
    .select("id, client_name, origin, destination");
  if (error) throw error;
  const created = (data ?? []) as { id: string; client_name: string; origin: string; destination: string }[];

  if (created.length) {
    const docs = created.flatMap((s) =>
      STANDARD_DOCUMENTS.map((name) => ({
        shipment_id: s.id,
        name,
        done: false,
        is_standard: true,
      })),
    );
    const { error: docError } = await supabase.from("documents").insert(docs);
    if (docError) throw docError;

    const { error: alertError } = await supabase.from("alerts").insert(
      created.map((s) => ({
        shipment_id: s.id,
        message: `Imported shipment for ${s.client_name} (${s.origin} → ${s.destination})`,
        to_status: "Booked" as const,
      })),
    );
    if (alertError) throw alertError;
  }

  return created.length;
}

/* ------------------------------------------------ automated status pipeline */

/**
 * Everything an automation decision needs persisted. The date-based sweep
 * (`deriveAutomation`) and the AIS webhook (`deriveAisAutomation`) both
 * produce one of these, and BOTH persist it through `applyAutomation()` —
 * there is exactly one write path for an automatic lifecycle change.
 */
export type AutomationDecision = {
  status: ShipmentStatus;
  monitoring_state: MonitoringState;
  reason: string;
  /** Why the monitoring state changed, when it did (defaults to `reason`). */
  monitoringReason?: string | null;
  source: EventSource;
  statusChanged: boolean;
  monitoringChanged: boolean;
  /** AIS debounce state to persist. Omit for decisions that don't touch it (the date-based sweep). */
  pending?: { status: ActiveShipmentStatus | null; since: string | null };
  /**
   * When the evidence behind a status change was first observed — the identity
   * of the logical transition (AIS: the pending candidate's first observation;
   * date-based: the operator-recorded fact's timestamp). Feeds the dedupe key.
   */
  evidenceAt?: string | null;
  /** Milestone timestamps to stamp with the AIS observation time (only ever fills an empty column). */
  stampActualDeparture?: string | null;
  stampActualArrival?: string | null;
};

export type AutomationOutcomeKind =
  | "applied" // written
  | "noop" // nothing to change
  | "conflict" // the shipment no longer matches what was evaluated (another writer won); nothing written
  | "held" // an operator hold is in force; nothing written
  | "duplicate" // this logical transition was already recorded; nothing written
  | "rejected" // not a forward move between active statuses; nothing written
  | "not_found";

export type AutomationOutcome = {
  outcome: AutomationOutcomeKind;
  statusChanged: boolean;
  monitoringChanged: boolean;
  pendingChanged: boolean;
};

/**
 * Deterministic identity of one logical automated transition. Built only from
 * stable inputs (shipment, from, to, source, and when the evidence was first
 * observed) — never a random id, never the time of the write — so the same
 * transition attempted twice, by anyone, yields the same key, and the unique
 * index on `shipment_events.dedupe_key` turns the second attempt into a no-op.
 * A later, genuinely different transition has different evidence and so a
 * different key.
 */
export function transitionDedupeKey(
  shipmentId: string,
  from: ShipmentStatus,
  to: ShipmentStatus,
  source: EventSource,
  evidenceAt: string | null | undefined,
): string | null {
  if (!evidenceAt) return null;
  const ms = new Date(evidenceAt).getTime();
  if (!Number.isFinite(ms)) return null;
  return `status:${shipmentId}:${from}>${to}:${source}:${new Date(ms).toISOString()}`;
}

const asIsoOrNull = (value: string | null | undefined) => {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

type RpcResult = { outcome?: AutomationOutcomeKind; status_changed?: boolean; monitoring_changed?: boolean; pending_changed?: boolean };

/**
 * Persists an automation decision ATOMICALLY through the database's
 * `apply_automation_decision()`: one transaction, under a row lock, that
 *  - acts only if the shipment is still exactly as it was evaluated
 *    (compare-and-set on status and on the AIS pending candidate),
 *  - stands down entirely while an operator hold is in force,
 *  - never moves a shipment backward,
 *  - writes the shipment change, its history event and its alert together, or
 *    not at all, and
 *  - records the same logical transition at most once (dedupe key).
 * A `conflict` / `held` / `duplicate` outcome is not an error: it means
 * someone else already dealt with it, and nothing was written.
 */
export async function applyAutomation(
  shipment: Shipment,
  decision: AutomationDecision,
  db: Db = supabase,
): Promise<AutomationOutcome> {
  const pendingProvided = decision.pending !== undefined;
  const newPendingStatus = pendingProvided ? (decision.pending!.status ?? null) : null;
  const newPendingSince = pendingProvided ? decision.pending!.since : null;
  const pendingChanged =
    pendingProvided &&
    (newPendingStatus !== shipment.ais_pending_status || newPendingSince !== shipment.ais_pending_since);

  const nothing: AutomationOutcome = { outcome: "noop", statusChanged: false, monitoringChanged: false, pendingChanged: false };
  if (!decision.statusChanged && !decision.monitoringChanged && !pendingChanged) return nothing;

  const evidenceAt = asIsoOrNull(decision.evidenceAt);
  const dedupeKey = decision.statusChanged
    ? transitionDedupeKey(shipment.id, shipment.status, decision.status, decision.source, evidenceAt)
    : null;
  const alertMessage = decision.statusChanged
    ? `${shortId(shipment.id)} · ${shipment.client_name} automatically moved to ${decision.status} — ${decision.reason}`
    : null;

  const { data, error } = await db.rpc("apply_automation_decision", {
    p_shipment_id: shipment.id,
    p_expected_status: shipment.status,
    p_new_status: decision.statusChanged ? decision.status : shipment.status,
    p_expected_monitoring_state: shipment.monitoring_state,
    p_new_monitoring_state: decision.monitoringChanged ? decision.monitoring_state : shipment.monitoring_state,
    p_expected_pending_status: shipment.ais_pending_status,
    p_expected_pending_since: shipment.ais_pending_since,
    p_new_pending_status: newPendingStatus,
    p_new_pending_since: newPendingSince,
    p_update_pending: pendingChanged,
    p_source: decision.source,
    p_actor: "Automation",
    p_reason: decision.reason,
    p_monitoring_reason: decision.monitoringReason ?? null,
    p_status_dedupe_key: dedupeKey,
    p_occurred_at: null,
    p_stamp_actual_departure: asIsoOrNull(decision.stampActualDeparture),
    p_stamp_actual_arrival: asIsoOrNull(decision.stampActualArrival),
    p_alert_message: alertMessage,
  });
  if (error) throw error;

  const r = (data ?? {}) as RpcResult;
  return {
    outcome: r.outcome ?? "noop",
    statusChanged: Boolean(r.status_changed),
    monitoringChanged: Boolean(r.monitoring_changed),
    pendingChanged: Boolean(r.pending_changed),
  };
}

/* ------------------------------------------------------ manual status override */

export type ManualStatusOutcome = {
  outcome: "applied" | "noop" | "conflict" | "not_found";
  /** True when the change moved the shipment backward (a correction) — automation is then held. */
  backward: boolean;
  holdUntil: string | null;
};

/**
 * An operator changes a shipment's lifecycle status, through the database's
 * `apply_manual_status_change()`: one transaction that records a MANUAL event
 * (never disguised as automation), voids any pending AIS candidate, and — for
 * a backward correction — holds automation so it cannot immediately undo the
 * correction, and clears any milestone timestamp the corrected status now
 * contradicts. `expectedStatus` makes the change conditional on the shipment
 * still being in that status.
 */
export async function applyManualStatusChange(input: {
  shipmentId: string;
  newStatus: ShipmentStatus;
  expectedStatus?: ShipmentStatus | null;
  eventType: string;
  reason?: string | null;
  alertMessage?: string | null;
  actor?: string;
}, db: Db = supabase): Promise<ManualStatusOutcome> {
  const { data, error } = await db.rpc("apply_manual_status_change", {
    p_shipment_id: input.shipmentId,
    p_new_status: input.newStatus,
    p_expected_status: input.expectedStatus ?? null,
    p_event_type: input.eventType,
    p_reason: input.reason ?? null,
    p_actor: input.actor ?? "Operator",
    p_alert_message: input.alertMessage ?? null,
  });
  if (error) throw error;
  const r = (data ?? {}) as { outcome?: ManualStatusOutcome["outcome"]; backward?: boolean; hold_until?: string | null };
  return { outcome: r.outcome ?? "noop", backward: Boolean(r.backward), holdUntil: r.hold_until ?? null };
}

/**
 * Manual status override. This is a correction/exception path: the automated
 * pipeline stays the primary source of truth, so the event is recorded as
 * manual (never automated) and is clearly labelled as an override. A backward
 * correction puts automation on hold for `automation_hold_hours` (default 24)
 * so the corrected status is not immediately re-advanced from the same
 * evidence; `resumeAutomation()` ends the hold early.
 */
export async function overrideStatus(
  shipment: Shipment,
  status: ShipmentStatus,
  reason?: string | null,
  db: Db = supabase,
) {
  if (status === shipment.status) return;
  await applyManualStatusChange({
    shipmentId: shipment.id,
    newStatus: status,
    eventType: "status_override",
    reason: reason?.trim() ? reason.trim() : "Manual override (correction)",
    alertMessage: `${shortId(shipment.id)} · ${shipment.client_name} manually overridden to ${status}`,
  }, db);
}

/** Ends an automation hold early; AIS automation restarts from fresh evidence. */
export async function resumeAutomation(shipmentId: string, db: Db = supabase) {
  const { data, error } = await db.rpc("resume_shipment_automation", { p_shipment_id: shipmentId, p_actor: "Operator" });
  if (error) throw error;
  return ((data ?? {}) as { outcome?: string }).outcome ?? "noop";
}

/* ------------------------------------------------------------ shipment notes */

export type ShipmentNote = {
  id: string;
  shipment_id: string;
  body: string;
  author: string | null;
  created_at: string;
  updated_at: string;
};

export async function listNotes(shipmentId: string) {
  const { data, error } = await supabase
    .from("shipment_notes")
    .select("*")
    .eq("shipment_id", shipmentId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as ShipmentNote[];
}

export async function createNote(shipmentId: string, body: string, author?: string | null) {
  const text = body.trim();
  if (!text) throw new Error("A note cannot be empty.");
  const { error } = await supabase
    .from("shipment_notes")
    .insert({ shipment_id: shipmentId, body: text, author: author ?? "Operator" });
  if (error) throw error;
}

export async function updateNote(id: string, body: string) {
  const text = body.trim();
  if (!text) throw new Error("A note cannot be empty.");
  const { error } = await supabase.from("shipment_notes").update({ body: text }).eq("id", id);
  if (error) throw error;
}

export async function deleteNote(id: string) {
  const { error } = await supabase.from("shipment_notes").delete().eq("id", id);
  if (error) throw error;
}
