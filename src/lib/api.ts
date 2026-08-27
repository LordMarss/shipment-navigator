import { supabase } from "@/integrations/supabase/client";

export const STATUSES = [
  "Booked",
  "In Transit",
  "At Port",
  "Cleared Customs",
  "Delivered",
] as const;

export type ShipmentStatus = (typeof STATUSES)[number];

export type Shipment = {
  id: string;
  client_name: string;
  origin: string;
  destination: string;
  vessel_name: string | null;
  vessel_mmsi: string | null;
  landed_cost: number | null;
  status: ShipmentStatus;
  created_at: string;
};

export type ShipmentDocument = {
  id: string;
  shipment_id: string;
  name: string;
  done: boolean;
};

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
}) {
  const { data, error } = await supabase
    .from("shipments")
    .insert({ ...input, status: "Booked" })
    .select("*")
    .single();
  if (error) throw error;
  const shipment = data as Shipment;

  const { error: docError } = await supabase
    .from("documents")
    .insert(STANDARD_DOCUMENTS.map((name) => ({ shipment_id: shipment.id, name, done: false })));
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

export async function toggleDocument(doc: ShipmentDocument) {
  const { error } = await supabase.from("documents").update({ done: !doc.done }).eq("id", doc.id);
  if (error) throw error;
}

export async function deleteShipment(id: string) {
  const { error } = await supabase.from("shipments").delete().eq("id", id);
  if (error) throw error;
}
