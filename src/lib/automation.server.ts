/**
 * Server-side automated status runner.
 *
 * Reuses the exact same pipeline as the app: `deriveAutomation()` decides what
 * a shipment's status / monitoring state should be from stored dates, and
 * `applyAutomation()` persists it (append-only events, no duplicates because a
 * write only happens when the derived values differ from the stored ones).
 *
 * No AIS data, no prediction. Planned ETD/ETA and the actual timestamps are
 * never overwritten here.
 */
import { applyAutomation, type Db, type Shipment } from "@/lib/api";
import { deriveAutomation } from "@/lib/autoStatus";
import { DEFAULT_MONITORING_CONFIG, type MonitoringConfig } from "@/lib/lifecycle";

async function loadConfig(db: Db): Promise<MonitoringConfig> {
  const { data, error } = await db.from("app_settings").select("key, value");
  if (error) {
    console.error("[automation] failed to load settings, using defaults:", error.message);
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

export type SweepResult = {
  evaluated: number;
  updated: number;
  failed: number;
  ranAt: string;
};

export async function runAutomationSweep(db: Db): Promise<SweepResult> {
  const ranAt = new Date().toISOString();
  const config = await loadConfig(db);

  // Eligible = not completed. Delivered shipments are never re-evaluated.
  const { data, error } = await db
    .from("shipments")
    .select("*")
    .neq("status", "Delivered")
    .is("actual_delivery", null);
  if (error) throw error;

  const shipments = (data ?? []) as Shipment[];
  let updated = 0;
  let failed = 0;

  for (const shipment of shipments) {
    try {
      const decision = deriveAutomation(shipment, config);
      if (!decision.statusChanged && !decision.monitoringChanged) continue;
      await applyAutomation(shipment, decision, db);
      updated += 1;
    } catch (e) {
      failed += 1;
      console.error(
        `[automation] shipment ${shipment.id} failed:`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  // Stamp the sweep on every evaluated shipment so the UI can show when the
  // background runner last checked, even when nothing changed.
  if (shipments.length) {
    const { error: syncError } = await db
      .from("shipments")
      .update({ last_synced_at: ranAt })
      .in(
        "id",
        shipments.map((s) => s.id),
      );
    if (syncError) console.error("[automation] last_synced_at update failed:", syncError.message);
  }

  return { evaluated: shipments.length, updated, failed, ranAt };
}
