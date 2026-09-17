/**
 * Server-side evaluation triggered by the AIS position webhook
 * (src/routes/api/public/hooks/ais-position.ts).
 *
 * Contains zero AIS business rules of its own — it only finds which
 * active shipment(s) a given MMSI's fresh position affects and runs the
 * existing `deriveAisAutomation()` / `applyAisDecision()` pair (Phase 3,
 * unchanged) against each. `aisAutomation.ts` remains the sole source of
 * truth for what qualifies as a status change, including the 15-minute
 * confirmation and staleness rules — this module never touches that logic.
 */
import { getPortById, getVesselPositionForShipment, isLegacyStatus, type Db, type Port, type Shipment } from "@/lib/api";
import { applyAisDecision, deriveAisAutomation } from "@/lib/aisAutomation";
import { DEFAULT_MONITORING_CONFIG, type MonitoringConfig } from "@/lib/lifecycle";

// Mirrors automation.server.ts's loadConfig exactly. Duplicated (not
// imported) so this event-driven webhook path has no coupling to the
// separate daily cron sweep's module — two independent triggers reading
// the same settings table, not two callers of shared trigger-specific code.
async function loadConfig(db: Db): Promise<MonitoringConfig> {
  const { data, error } = await db.from("app_settings").select("key, value");
  if (error) {
    console.error("[ais-webhook] failed to load settings, using defaults:", error.message);
    return DEFAULT_MONITORING_CONFIG;
  }
  const config = { ...DEFAULT_MONITORING_CONFIG };
  for (const row of data ?? []) {
    const n = Number(row.value as unknown as number);
    if (!Number.isNaN(n) && row.key in config) {
      (config as unknown as Record<string, number>)[row.key] = n;
    }
  }
  return config;
}

export type AisWebhookResult = {
  evaluated: number;
  updated: number;
};

/**
 * Evaluates every active (non-legacy) shipment whose vessel_mmsi matches the
 * given MMSI against the latest persisted vessel_positions row.
 *
 * Idempotent / safe to call repeatedly for the same position:
 * deriveAisAutomation() is a pure function of (shipment, position, config,
 * now), and applyAisDecision() only performs a write when the derived
 * status, monitoring state, or pending-candidate fields actually differ
 * from what's stored — a duplicate webhook delivery for an unchanged
 * position produces zero writes and zero events on the second call.
 *
 * Uses the latest persisted vessel_positions row (by mmsi) as the sole
 * source of truth, exactly as aisAutomation.ts already does — the ingestion
 * worker owns write ordering (it always upserts by mmsi), so an
 * out-of-order webhook delivery cannot make a stale position win: whichever
 * webhook fires, this reads whatever is currently the latest row.
 */
export async function evaluateAisPositionForMmsi(
  mmsi: string,
  db: Db,
  now: number = Date.now(),
): Promise<AisWebhookResult> {
  const { data, error } = await db.from("shipments").select("*").eq("vessel_mmsi", mmsi);
  if (error) throw error;

  const shipments = ((data ?? []) as Shipment[]).filter((s) => !isLegacyStatus(s.status));
  if (shipments.length === 0) return { evaluated: 0, updated: 0 };

  const config = await loadConfig(db);
  const position = await getVesselPositionForShipment({ vessel_mmsi: mmsi }, db);

  // Small per-run cache: multiple shipments can share the same destination
  // port, so this avoids re-fetching it once per shipment in that case.
  const portCache = new Map<string, Port | null>();
  const loadDestinationPort = async (portId: string | null): Promise<Port | null> => {
    if (!portId) return null;
    if (!portCache.has(portId)) portCache.set(portId, await getPortById(portId, db));
    return portCache.get(portId) ?? null;
  };

  let updated = 0;
  for (const shipment of shipments) {
    const destinationPort = await loadDestinationPort(shipment.destination_port_id);
    const decision = deriveAisAutomation(shipment, position, config, now, destinationPort);
    const pendingChanged =
      decision.pendingStatus !== shipment.ais_pending_status || decision.pendingSince !== shipment.ais_pending_since;

    if (decision.statusChanged || decision.monitoringChanged || pendingChanged) {
      await applyAisDecision(shipment, decision, db);
    }
    if (decision.statusChanged) updated += 1;
  }

  return { evaluated: shipments.length, updated };
}
