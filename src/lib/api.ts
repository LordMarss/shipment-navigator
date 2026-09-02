import { supabase } from "@/integrations/supabase/client";

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
}) {
  const { data, error } = await supabase
    .from("shipments")
    .insert({ ...input, eta: input.eta ?? null, status: "Booked" })
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

export async function advanceStatus(shipment: Shipment) {
  const to = nextStatus(shipment.status);
  if (!to) return;
  await updateShipment(shipment.id, { status: to });
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
