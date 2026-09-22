/**
 * Pure validation and write-ordering rules for AIS position ingestion,
 * shared by the standalone worker (`scripts/ais-listener.ts`) and the tests.
 *
 * Deliberately dependency-free and limited to type-strippable TypeScript
 * (no enums, namespaces or parameter properties, no `@/` path aliases): the
 * worker runs under plain `node scripts/ais-listener.ts`, which imports this
 * file directly with no bundler or alias resolution in between.
 *
 * Scope is intentionally small. We keep exactly one latest position per MMSI
 * — no history — so all this does is (1) refuse to persist positions that
 * are obviously not real and (2) make sure an older report can never
 * overwrite a newer one already stored.
 */

/** ITU-R M.1371 "speed not available" (1023 in 0.1 kn units). */
const SOG_NOT_AVAILABLE_KNOTS = 102.3;
/** Position timestamps further ahead of receipt than this are treated as clock errors. */
export const MAX_FUTURE_TIMESTAMP_SKEW_MS = 5 * 60_000;

export type PositionRow = {
  mmsi: string;
  vessel_name: string | null;
  latitude: number;
  longitude: number;
  sog: number | null;
  cog: number | null;
  true_heading: number | null;
  nav_status: string | null;
  position_timestamp: string;
  received_at: string;
  source: string;
};

export type NormalizeResult = { ok: true; row: PositionRow } | { ok: false; reason: string };

/**
 * True only for a coordinate pair that can be a real vessel position:
 * finite numbers, latitude within -90..90, longitude within -180..180, and
 * not the (0, 0) "null island" pair that GPS-less transponders report.
 * (AIS's own "not available" markers, 91° latitude and 181° longitude, fall
 * outside the valid ranges and are rejected by them.)
 */
export function isPlausibleCoordinate(latitude: unknown, longitude: unknown): boolean {
  if (typeof latitude !== "number" || typeof longitude !== "number") return false;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return false;
  if (latitude === 0 && longitude === 0) return false;
  return true;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Validates one AISStream PositionReport and returns the row to persist, or
 * the reason it was rejected. Out-of-range motion fields are not grounds to
 * reject the position itself — they are stored as null ("unknown") instead,
 * which every consumer already treats as "no evidence".
 */
export function normalizePositionReport(input: {
  mmsi: string;
  vesselName: string | null;
  report: unknown;
  positionTimestamp: string;
  receivedAt: string;
}): NormalizeResult {
  if (!/^\d{9}$/.test(input.mmsi)) return { ok: false, reason: "invalid MMSI" };
  if (!input.report || typeof input.report !== "object") return { ok: false, reason: "missing position report" };

  const r = input.report as Record<string, unknown>;
  if (!isPlausibleCoordinate(r["Latitude"], r["Longitude"])) {
    return { ok: false, reason: "invalid or sentinel coordinates" };
  }

  const positionMs = new Date(input.positionTimestamp).getTime();
  const receivedMs = new Date(input.receivedAt).getTime();
  if (!Number.isFinite(positionMs) || !Number.isFinite(receivedMs)) {
    return { ok: false, reason: "invalid timestamp" };
  }
  // A future-dated position is not just wrong — because the store refuses to
  // let an older report replace a newer one, a single such row would block
  // every genuine report from this vessel until real time caught up to it.
  if (positionMs - receivedMs > MAX_FUTURE_TIMESTAMP_SKEW_MS) {
    return { ok: false, reason: "position timestamp is in the future" };
  }

  const sog = finiteOrNull(r["Sog"]);
  const cog = finiteOrNull(r["Cog"]);
  const heading = finiteOrNull(r["TrueHeading"]);
  const nav = finiteOrNull(r["NavigationalStatus"]);

  return {
    ok: true,
    row: {
      mmsi: input.mmsi,
      vessel_name: input.vesselName,
      latitude: r["Latitude"] as number,
      longitude: r["Longitude"] as number,
      sog: sog !== null && sog >= 0 && sog < SOG_NOT_AVAILABLE_KNOTS ? sog : null,
      cog: cog !== null && cog >= 0 && cog < 360 ? cog : null,
      true_heading: heading !== null && Number.isInteger(heading) && heading >= 0 && heading < 360 ? heading : null,
      nav_status: nav !== null && Number.isInteger(nav) && nav >= 0 && nav <= 15 ? String(nav) : null,
      position_timestamp: new Date(positionMs).toISOString(),
      received_at: new Date(receivedMs).toISOString(),
      source: "aisstream",
    },
  };
}

/** The two operations the write-ordering rule needs; the worker implements them against Supabase. */
export type PositionStore = {
  /** Update the existing row for row.mmsi only if its stored position_timestamp is null or not newer than row's. True if a row was updated. */
  updateIfNotNewer: (row: PositionRow) => Promise<boolean>;
  /** Insert row only if no row exists for row.mmsi. True if inserted. */
  insertIfAbsent: (row: PositionRow) => Promise<boolean>;
};

export type StoreOutcome = "updated" | "inserted" | "ignored_older";

/**
 * Persists a position as the vessel's latest, unless a NEWER one is already
 * stored. An update that matches nothing means either there is no row yet
 * (insert it) or the stored row is newer (the insert then finds it present,
 * and the incoming report is dropped as out of date).
 */
export async function storeLatestPosition(store: PositionStore, row: PositionRow): Promise<StoreOutcome> {
  if (await store.updateIfNotNewer(row)) return "updated";
  if (await store.insertIfAbsent(row)) return "inserted";
  return "ignored_older";
}
