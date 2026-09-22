/**
 * Deterministic tests for AIS ingestion hygiene: which positions may be
 * persisted at all, and the rule that an older report can never overwrite a
 * newer one already stored. Pure functions plus an in-memory PositionStore —
 * no network, no database.
 *
 *   npx tsx src/lib/aisPositionIngest.test.ts
 */
import assert from "node:assert/strict";

import {
  isPlausibleCoordinate,
  normalizePositionReport,
  storeLatestPosition,
  type PositionRow,
  type PositionStore,
} from "@/lib/aisPositionIngest";

const MINUTE = 60_000;
const NOW = Date.parse("2026-09-16T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok — ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL — ${name}`);
    console.error(err);
  }
}

const normalize = (report: unknown, over: Partial<{ mmsi: string; positionTimestamp: string; receivedAt: string }> = {}) =>
  normalizePositionReport({
    mmsi: "123456789",
    vesselName: "Test Vessel",
    report,
    positionTimestamp: iso(NOW),
    receivedAt: iso(NOW),
    ...over,
  });

const good = { Latitude: 43.97, Longitude: 9.87, Sog: 12.3, Cog: 187.5, TrueHeading: 190, NavigationalStatus: 0 };

// --- coordinates ------------------------------------------------------------

await test("a normal position is accepted and normalised", () => {
  const r = normalize(good);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.row.latitude, 43.97);
    assert.equal(r.row.sog, 12.3);
    assert.equal(r.row.nav_status, "0");
    assert.equal(r.row.position_timestamp, iso(NOW));
    assert.equal(r.row.source, "aisstream");
  }
});

await test("(0,0) 'null island' is rejected", () => {
  assert.equal(normalize({ ...good, Latitude: 0, Longitude: 0 }).ok, false);
  assert.equal(isPlausibleCoordinate(0, 0), false);
  // A point on the equator OR the prime meridian alone is a real place.
  assert.equal(isPlausibleCoordinate(0, 10), true);
  assert.equal(isPlausibleCoordinate(10, 0), true);
});

await test("latitude outside -90..90 is rejected (including AIS's own 91 'not available')", () => {
  for (const Latitude of [90.0001, -90.0001, 91, 200, -91]) {
    assert.equal(normalize({ ...good, Latitude }).ok, false, `lat ${Latitude}`);
  }
  assert.equal(normalize({ ...good, Latitude: 90 }).ok, true, "the poles themselves are in range");
  assert.equal(normalize({ ...good, Latitude: -90 }).ok, true);
});

await test("longitude outside -180..180 is rejected (including AIS's own 181 'not available')", () => {
  for (const Longitude of [180.0001, -180.0001, 181, 360]) {
    assert.equal(normalize({ ...good, Longitude }).ok, false, `lon ${Longitude}`);
  }
  assert.equal(normalize({ ...good, Longitude: 180 }).ok, true);
  assert.equal(normalize({ ...good, Longitude: -180 }).ok, true);
});

await test("non-finite / non-numeric coordinates are rejected", () => {
  for (const v of [Number.NaN, Infinity, -Infinity, "43.9", null, undefined]) {
    assert.equal(normalize({ ...good, Latitude: v }).ok, false, `lat ${String(v)}`);
    assert.equal(normalize({ ...good, Longitude: v }).ok, false, `lon ${String(v)}`);
  }
});

await test("a missing or malformed report / MMSI is rejected", () => {
  assert.equal(normalize(null).ok, false);
  assert.equal(normalize("nope").ok, false);
  assert.equal(normalize(good, { mmsi: "" }).ok, false);
  assert.equal(normalize(good, { mmsi: "12345" }).ok, false);
  assert.equal(normalize(good, { mmsi: "12345678x" }).ok, false);
});

// --- timestamps -------------------------------------------------------------

await test("a position timestamped far in the future is rejected; small clock skew is tolerated", () => {
  assert.equal(normalize(good, { positionTimestamp: iso(NOW + 60 * MINUTE) }).ok, false);
  assert.equal(normalize(good, { positionTimestamp: iso(NOW + 2 * MINUTE) }).ok, true);
  assert.equal(normalize(good, { positionTimestamp: "garbage" }).ok, false);
});

// --- motion sentinels -------------------------------------------------------

await test("'not available' motion values are stored as null, not as real readings", () => {
  const r = normalize({ ...good, Sog: 102.3, Cog: 360, TrueHeading: 511, NavigationalStatus: 99 });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.row.sog, null);
    assert.equal(r.row.cog, null);
    assert.equal(r.row.true_heading, null);
    assert.equal(r.row.nav_status, null);
  }
  const partial = normalize({ Latitude: 43.97, Longitude: 9.87 });
  assert.equal(partial.ok, true);
  if (partial.ok) assert.equal(partial.row.sog, null);
  const neg = normalize({ ...good, Sog: -1, Cog: -5 });
  assert.equal(neg.ok, true);
  if (neg.ok) {
    assert.equal(neg.row.sog, null);
    assert.equal(neg.row.cog, null);
  }
});

// --- write ordering ---------------------------------------------------------

/** In-memory stand-in for the Supabase-backed store, enforcing the same contract. */
function makeMemoryStore() {
  const rows = new Map<string, PositionRow>();
  const store: PositionStore = {
    async updateIfNotNewer(row) {
      const existing = rows.get(row.mmsi);
      if (!existing) return false;
      if (Date.parse(existing.position_timestamp) > Date.parse(row.position_timestamp)) return false;
      rows.set(row.mmsi, row);
      return true;
    },
    async insertIfAbsent(row) {
      if (rows.has(row.mmsi)) return false;
      rows.set(row.mmsi, row);
      return true;
    },
  };
  return { rows, store };
}

const rowAt = (ms: number, lat = 40): PositionRow => {
  const r = normalize({ ...good, Latitude: lat }, { positionTimestamp: iso(ms), receivedAt: iso(ms) });
  if (!r.ok) throw new Error("fixture must be valid");
  return r.row;
};

await test("first report for a vessel is inserted", async () => {
  const { rows, store } = makeMemoryStore();
  assert.equal(await storeLatestPosition(store, rowAt(NOW)), "inserted");
  assert.equal(rows.get("123456789")?.position_timestamp, iso(NOW));
});

await test("a NEWER report replaces the stored one", async () => {
  const { rows, store } = makeMemoryStore();
  await storeLatestPosition(store, rowAt(NOW, 40));
  assert.equal(await storeLatestPosition(store, rowAt(NOW + 5 * MINUTE, 41)), "updated");
  assert.equal(rows.get("123456789")?.latitude, 41);
});

await test("an OLDER report cannot overwrite a newer stored one", async () => {
  const { rows, store } = makeMemoryStore();
  await storeLatestPosition(store, rowAt(NOW, 40));
  assert.equal(await storeLatestPosition(store, rowAt(NOW - 10 * MINUTE, 55)), "ignored_older");
  assert.equal(rows.get("123456789")?.latitude, 40, "the newer position is untouched");
  assert.equal(rows.get("123456789")?.position_timestamp, iso(NOW));
});

await test("a replay of the same report is harmless (idempotent)", async () => {
  const { rows, store } = makeMemoryStore();
  await storeLatestPosition(store, rowAt(NOW, 40));
  assert.equal(await storeLatestPosition(store, rowAt(NOW, 40)), "updated");
  assert.equal(rows.size, 1);
  assert.equal(rows.get("123456789")?.latitude, 40);
});

await test("different vessels never interfere", async () => {
  const { rows, store } = makeMemoryStore();
  await storeLatestPosition(store, rowAt(NOW, 40));
  const other = normalize(good, { mmsi: "987654321", positionTimestamp: iso(NOW - 60 * MINUTE), receivedAt: iso(NOW) });
  if (!other.ok) throw new Error("fixture");
  assert.equal(await storeLatestPosition(store, other.row), "inserted");
  assert.equal(rows.size, 2);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
