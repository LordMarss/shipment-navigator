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
 */
export const STATUSES = [
  "Scheduled",
  "Booked",
  "Departed",
  "In Transit",
  "Approaching Destination",
  "Arrived",
  "At Port",
  "Cleared Customs",
  "Delivered",
] as const;

export type ShipmentStatus = (typeof STATUSES)[number];

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

export function nextStatus(status: ShipmentStatus): ShipmentStatus | null {
  const i = STATUSES.indexOf(status);
  return i >= 0 && i < STATUSES.length - 1 ? (STATUSES[i + 1] as ShipmentStatus) : null;
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

export async function logAlert(input: {
  shipment_id: string;
  message: string;
  from_status?: ShipmentStatus | null;
  to_status?: ShipmentStatus | null;
}) {
  const { error } = await supabase.from("alerts").insert({
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

export async function updateShipment(id: string, patch: Partial<Shipment>) {
  const { error } = await supabase.from("shipments").update(patch).eq("id", id);
  if (error) throw error;
}

/** Manual status advance — preserved as the fallback for the automation. */
export async function advanceStatus(shipment: Shipment) {
  const to = nextStatus(shipment.status);
  if (!to) return;
  await updateShipment(shipment.id, { status: to });
  await recordEvent({
    shipment_id: shipment.id,
    event_type: "status_manual",
    category: "status",
    field: "Status",
    from_value: shipment.status,
    to_value: to,
    source: "manual",
    automated: false,
  });
  await logAlert({
    shipment_id: shipment.id,
    message: `${shortId(shipment.id)} · ${shipment.client_name} moved to ${to}`,
    from_status: shipment.status,
    to_status: to,
  });
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

export async function recordEvent(input: {
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
}) {
  const { error } = await supabase.from("shipment_events").insert({
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
) {
  const changed = Object.entries(patch).filter(
    ([k, v]) => (v ?? null) !== ((shipment as Record<string, unknown>)[k] ?? null),
  );
  if (changed.length === 0) return;

  const etaChanged = changed.some(([k]) => k === "eta");
  await updateShipment(shipment.id, {
    ...patch,
    ...(etaChanged ? { previous_eta: shipment.eta } : {}),
  });

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
    });
  }

  if (etaChanged) {
    const to = (patch.eta as string | null) ?? null;
    if (shipment.eta && to) {
      const hours = Math.round(
        (new Date(to).getTime() - new Date(shipment.eta).getTime()) / 3_600_000,
      );
      await logAlert({
        shipment_id: shipment.id,
        message: `ETA changed by ${Math.abs(hours)} hours ${hours >= 0 ? "later" : "earlier"}`,
      });
    } else if (to) {
      await logAlert({ shipment_id: shipment.id, message: `ETA set to ${formatEta(to)}` });
    }
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
 * Persists an automated status / monitoring transition. Every change is written
 * as its own append-only event so automated moves stay distinguishable from
 * manual ones, and previous history is never overwritten.
 */
export async function applyAutomation(
  shipment: Shipment,
  decision: {
    status: ShipmentStatus;
    monitoring_state: MonitoringState;
    reason: string;
    source: EventSource;
    statusChanged: boolean;
    monitoringChanged: boolean;
  },
) {
  const now = new Date().toISOString();
  const patch: Partial<Shipment> = { last_synced_at: now };
  if (decision.statusChanged) patch.status = decision.status;
  if (decision.monitoringChanged) patch.monitoring_state = decision.monitoring_state;

  await updateShipment(shipment.id, patch);

  if (decision.statusChanged) {
    await recordEvent({
      shipment_id: shipment.id,
      event_type: "status_auto",
      category: "status",
      field: "Status",
      from_value: shipment.status,
      to_value: decision.status,
      source: decision.source,
      automated: true,
      actor: "Automation",
      reason: decision.reason,
      occurred_at: now,
    });
    await logAlert({
      shipment_id: shipment.id,
      message: `${shortId(shipment.id)} · ${shipment.client_name} automatically moved to ${decision.status} — ${decision.reason}`,
      from_status: shipment.status,
      to_status: decision.status,
    });
  }

  if (decision.monitoringChanged) {
    await recordEvent({
      shipment_id: shipment.id,
      event_type: "monitoring_auto",
      category: "monitoring",
      field: "Monitoring state",
      from_value: String(shipment.monitoring_state),
      to_value: decision.monitoring_state,
      source: "system",
      automated: true,
      actor: "Automation",
      reason: decision.reason,
      occurred_at: now,
    });
  }
}
