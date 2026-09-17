/**
 * Deterministic tests for the Phase 4B AIS webhook integration:
 *   - handleAisPositionWebhook (auth + payload validation), tested via
 *     dependency injection so no real Supabase client is needed.
 *   - evaluateAisPositionForMmsi (shipment matching + automation
 *     integration), tested against a small in-memory fake Db rather than a
 *     real Supabase project.
 *
 * Does not touch or re-test deriveAisAutomation()'s own rules — those are
 * covered by the existing, untouched src/lib/aisAutomation.test.ts. These
 * tests only verify the plumbing around it: matching, dispatch, and that
 * repeated/duplicate invocations behave safely.
 *
 * Run: npx tsx src/lib/aisWebhook.server.test.ts
 */
import assert from "node:assert/strict";

import type { Db, Shipment, VesselPosition } from "@/lib/api";
import { AIS_CONFIRMATION_MINUTES } from "@/lib/aisAutomation";
import { evaluateAisPositionForMmsi } from "@/lib/aisWebhook.server";
import { handleAisPositionWebhook } from "@/routes/api/public/hooks/ais-position";

const DAY = 86_400_000;
const MINUTE = 60_000;
const NOW = Date.parse("2026-09-16T12:00:00Z");

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ok — ${name}`);
    })
    .catch((err) => {
      failed += 1;
      console.error(`FAIL — ${name}`);
      console.error(err);
    });
}

// --- fixtures -----------------------------------------------------------

function makeShipment(overrides: Partial<Shipment> = {}): Shipment {
  return {
    id: overrides.id ?? "shipment-1",
    client_name: "Test Client",
    origin: "Shanghai",
    destination: "Los Angeles",
    vessel_name: "Test Vessel",
    vessel_mmsi: "123456789",
    vessel_imo: null,
    origin_port_id: null,
    destination_port_id: null,
    landed_cost: null,
    status: "Booked",
    eta: null,
    previous_eta: null,
    planned_etd: new Date(NOW - 2 * DAY).toISOString(),
    planned_eta: null,
    actual_departure: null,
    actual_arrival: null,
    actual_delivery: null,
    health: "On Track",
    health_reason: null,
    monitoring_state: "Active Monitoring",
    monitoring_start_offset_days: null,
    ais_pending_status: null,
    ais_pending_since: null,
    reference: null,
    carrier: null,
    container_number: null,
    customer_reference: null,
    last_synced_at: null,
    updated_at: new Date(NOW).toISOString(),
    created_at: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function makePosition(overrides: Partial<VesselPosition> = {}): VesselPosition {
  return {
    mmsi: "123456789",
    vessel_name: "Test Vessel",
    latitude: 31.2,
    longitude: 121.5,
    sog: 6,
    cog: null,
    true_heading: null,
    nav_status: "0",
    position_timestamp: new Date(NOW).toISOString(),
    received_at: new Date(NOW).toISOString(),
    source: "aisstream",
    updated_at: new Date(NOW).toISOString(),
    ...overrides,
  };
}

type EventRow = { source: string };

// --- a tiny fake Db, covering exactly the query shapes this integration
// uses (select+eq[+maybeSingle], update+eq, insert) --------------------

type Row = Record<string, unknown>;
type Tables = {
  shipments: Row[];
  vessel_positions: Row[];
  app_settings: Row[];
  shipment_events: Row[];
  alerts: Row[];
};
type FakeDb = Db & { tables: Tables };

function makeFakeDb(seed: { shipments?: Row[]; vessel_positions?: Row[]; app_settings?: Row[] } = {}): FakeDb {
  const tables: Record<string, Row[]> = {
    shipments: seed.shipments ?? [],
    vessel_positions: seed.vessel_positions ?? [],
    app_settings: seed.app_settings ?? [],
    shipment_events: [],
    alerts: [],
  };

  function from(table: string) {
    const rows = () => (tables[table] ??= []);

    function selectBuilder(filters: Array<[string, unknown]>) {
      const applyFilters = (data: Row[]) => data.filter((r) => filters.every(([k, v]) => r[k] === v));
      return {
        eq(col: string, val: unknown) {
          return selectBuilder([...filters, [col, val]]);
        },
        maybeSingle() {
          return Promise.resolve({ data: applyFilters(rows())[0] ?? null, error: null });
        },
        then(resolve: (v: { data: Row[]; error: null }) => void, reject: (e: unknown) => void) {
          return Promise.resolve({ data: applyFilters(rows()), error: null }).then(resolve, reject);
        },
      };
    }

    return {
      select(_cols: string) {
        return selectBuilder([]);
      },
      update(patch: Row) {
        return {
          eq(col: string, val: unknown) {
            for (const r of rows()) {
              if (r[col] === val) Object.assign(r, patch);
            }
            return Promise.resolve({ error: null });
          },
        };
      },
      insert(obj: Row) {
        rows().push({ id: `${table}-${rows().length + 1}`, ...obj });
        return Promise.resolve({ error: null });
      },
    };
  }

  return { from, tables } as unknown as FakeDb;
}

/** Typed views over the fake db's tables, so assertions read naturally instead of via bracket access on Record<string, unknown>. */
function shipmentsOf(db: FakeDb): Shipment[] {
  return db.tables.shipments as unknown as Shipment[];
}
function positionsOf(db: FakeDb): VesselPosition[] {
  return db.tables.vessel_positions as unknown as VesselPosition[];
}
function eventsOf(db: FakeDb): EventRow[] {
  return db.tables.shipment_events as unknown as EventRow[];
}

function setWebhookSecret(value: string) {
  process.env["AIS_WEBHOOK_SECRET"] = value;
}

// --- Authentication -------------------------------------------------------

const validRequest = (headers: Record<string, string> = {}) =>
  new Request("https://example.com/api/public/hooks/ais-position", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ type: "UPDATE", record: { mmsi: "123456789" } }),
  });

await test("auth: missing secret header is rejected with 401", async () => {
  setWebhookSecret("test-secret");
  const res = await handleAisPositionWebhook(validRequest(), async () => ({ evaluated: 0, updated: 0 }));
  assert.equal(res.status, 401);
});

await test("auth: invalid secret is rejected with 401", async () => {
  setWebhookSecret("test-secret");
  const res = await handleAisPositionWebhook(
    validRequest({ "x-ais-webhook-secret": "wrong-secret" }),
    async () => ({ evaluated: 0, updated: 0 }),
  );
  assert.equal(res.status, 401);
});

await test("auth: valid secret is accepted", async () => {
  setWebhookSecret("test-secret");
  let called = false;
  const res = await handleAisPositionWebhook(
    validRequest({ "x-ais-webhook-secret": "test-secret" }),
    async () => {
      called = true;
      return { evaluated: 1, updated: 0 };
    },
  );
  assert.equal(res.status, 200);
  assert.equal(called, true);
});

// --- Payload validation -----------------------------------------------------

await test("payload: malformed JSON body is rejected with 400", async () => {
  setWebhookSecret("test-secret");
  const req = new Request("https://example.com/api/public/hooks/ais-position", {
    method: "POST",
    headers: { "x-ais-webhook-secret": "test-secret", "content-type": "application/json" },
    body: "{not json",
  });
  const res = await handleAisPositionWebhook(req, async () => ({ evaluated: 0, updated: 0 }));
  assert.equal(res.status, 400);
});

await test("payload: missing mmsi is rejected with 400", async () => {
  setWebhookSecret("test-secret");
  const req = new Request("https://example.com/api/public/hooks/ais-position", {
    method: "POST",
    headers: { "x-ais-webhook-secret": "test-secret", "content-type": "application/json" },
    body: JSON.stringify({ type: "UPDATE", record: { latitude: 1, longitude: 2 } }),
  });
  const res = await handleAisPositionWebhook(req, async () => ({ evaluated: 0, updated: 0 }));
  assert.equal(res.status, 400);
});

await test("payload: valid mmsi is accepted and passed through to the evaluator", async () => {
  setWebhookSecret("test-secret");
  let receivedMmsi: string | null = null;
  const res = await handleAisPositionWebhook(
    validRequest({ "x-ais-webhook-secret": "test-secret" }),
    async (mmsi) => {
      receivedMmsi = mmsi;
      return { evaluated: 1, updated: 0 };
    },
  );
  const body = (await res.json()) as { ok: boolean; mmsi: string; evaluated: number };
  assert.equal(res.status, 200);
  assert.equal(receivedMmsi, "123456789");
  assert.equal(body.ok, true);
  assert.equal(body.mmsi, "123456789");
});

// --- Shipment matching ------------------------------------------------------

await test("matching: no matching shipment returns a successful zero evaluation", async () => {
  const db = makeFakeDb({ shipments: [] });
  const result = await evaluateAisPositionForMmsi("999999999", db, NOW);
  assert.deepEqual(result, { evaluated: 0, updated: 0 });
});

await test("matching: one matching active shipment is evaluated", async () => {
  const shipment = makeShipment({ id: "s1", vessel_mmsi: "111111111" });
  const position = makePosition({ mmsi: "111111111", sog: 0.1, nav_status: "5" }); // moored, no evidence
  const db = makeFakeDb({ shipments: [shipment] as unknown as Row[], vessel_positions: [position] as unknown as Row[] });
  const result = await evaluateAisPositionForMmsi("111111111", db, NOW);
  assert.equal(result.evaluated, 1);
});

await test("matching: multiple matching active shipments are all evaluated", async () => {
  const shipmentA = makeShipment({ id: "s1", vessel_mmsi: "222222222" });
  const shipmentB = makeShipment({ id: "s2", vessel_mmsi: "222222222", status: "Departed" });
  const position = makePosition({ mmsi: "222222222", sog: 0.1, nav_status: "5" });
  const db = makeFakeDb({
    shipments: [shipmentA, shipmentB] as unknown as Row[],
    vessel_positions: [position] as unknown as Row[],
  });
  const result = await evaluateAisPositionForMmsi("222222222", db, NOW);
  assert.equal(result.evaluated, 2);
});

await test("matching: a legacy shipment sharing the MMSI is not evaluated", async () => {
  const active = makeShipment({ id: "s1", vessel_mmsi: "333333333", status: "Booked" });
  const legacy = makeShipment({ id: "s2", vessel_mmsi: "333333333", status: "Delivered" });
  const position = makePosition({ mmsi: "333333333", sog: 0.1, nav_status: "5" });
  const db = makeFakeDb({
    shipments: [active, legacy] as unknown as Row[],
    vessel_positions: [position] as unknown as Row[],
  });
  const result = await evaluateAisPositionForMmsi("333333333", db, NOW);
  assert.equal(result.evaluated, 1, "only the active shipment counts");
});

// --- Automation integration --------------------------------------------------

await test("integration: qualifying first observation creates a pending candidate, no status change", async () => {
  const shipment = makeShipment({ id: "s1", vessel_mmsi: "444444444", status: "Booked" });
  const underway = makePosition({ mmsi: "444444444", sog: 6, nav_status: "0" });
  const db = makeFakeDb({ shipments: [shipment] as unknown as Row[], vessel_positions: [underway] as unknown as Row[] });

  const result = await evaluateAisPositionForMmsi("444444444", db, NOW);
  assert.equal(result.updated, 0);

  const stored = shipmentsOf(db)[0]!;
  assert.equal(stored.ais_pending_status, "Departed");
  assert.equal(stored.status, "Booked");
  assert.equal(eventsOf(db).length, 0, "no event yet — nothing confirmed");
});

await test("integration: repeated identical webhook does not promote early and creates no event", async () => {
  const shipment = makeShipment({ id: "s1", vessel_mmsi: "555555555", status: "Booked" });
  const underway = makePosition({ mmsi: "555555555", sog: 6, nav_status: "0" });
  const db = makeFakeDb({ shipments: [shipment] as unknown as Row[], vessel_positions: [underway] as unknown as Row[] });

  await evaluateAisPositionForMmsi("555555555", db, NOW);
  const pendingSinceAfterFirst = shipmentsOf(db)[0]!.ais_pending_since;

  // Same webhook, same position, same moment in time — as a retried delivery would look.
  const result = await evaluateAisPositionForMmsi("555555555", db, NOW);
  assert.equal(result.updated, 0);
  assert.equal(shipmentsOf(db)[0]!.status, "Booked");
  assert.equal(
    shipmentsOf(db)[0]!.ais_pending_since,
    pendingSinceAfterFirst,
    "debounce timer must not reset on a duplicate delivery",
  );
  assert.equal(eventsOf(db).length, 0);
});

await test("integration: qualifying second observation after 15+ minutes promotes and records exactly one event", async () => {
  const shipment = makeShipment({ id: "s1", vessel_mmsi: "666666666", status: "Booked" });
  const underway = makePosition({ mmsi: "666666666", sog: 6, nav_status: "0" });
  const db = makeFakeDb({ shipments: [shipment] as unknown as Row[], vessel_positions: [underway] as unknown as Row[] });

  await evaluateAisPositionForMmsi("666666666", db, NOW);
  assert.equal(shipmentsOf(db)[0]!.status, "Booked", "not yet — only one observation so far");

  const later = NOW + (AIS_CONFIRMATION_MINUTES + 1) * MINUTE;
  // A fresh position for the second observation (as a real new AIS message would carry).
  positionsOf(db)[0]!.position_timestamp = new Date(later).toISOString();
  const result = await evaluateAisPositionForMmsi("666666666", db, later);

  assert.equal(result.updated, 1);
  assert.equal(shipmentsOf(db)[0]!.status, "Departed");
  assert.equal(shipmentsOf(db)[0]!.ais_pending_status, null, "candidate is consumed once promoted");
  assert.equal(eventsOf(db).length, 1, "exactly one event for the confirmed transition");
  assert.equal(eventsOf(db)[0]!.source, "ais");

  // A third, later call with nothing new must not add a second event.
  await evaluateAisPositionForMmsi("666666666", db, later + MINUTE);
  assert.equal(eventsOf(db).length, 1, "no duplicate event once settled");
});

await test("integration: non-qualifying observation does not change status", async () => {
  const shipment = makeShipment({ id: "s1", vessel_mmsi: "777777777", status: "Booked" });
  const moored = makePosition({ mmsi: "777777777", sog: 0.1, nav_status: "5" });
  const db = makeFakeDb({ shipments: [shipment] as unknown as Row[], vessel_positions: [moored] as unknown as Row[] });

  const result = await evaluateAisPositionForMmsi("777777777", db, NOW);
  assert.equal(result.updated, 0);
  assert.equal(shipmentsOf(db)[0]!.status, "Booked");
  assert.equal(shipmentsOf(db)[0]!.ais_pending_status, null);
});

await test("integration: stale AIS does not promote even a previously-pending candidate", async () => {
  const shipment = makeShipment({
    id: "s1",
    vessel_mmsi: "888888888",
    status: "Booked",
    ais_pending_status: "Departed",
    ais_pending_since: new Date(NOW - 20 * MINUTE).toISOString(), // already past the confirmation window
  });
  const stale = makePosition({
    mmsi: "888888888",
    sog: 6,
    nav_status: "0",
    position_timestamp: new Date(NOW - 48 * 3_600_000).toISOString(),
  });
  const db = makeFakeDb({ shipments: [shipment] as unknown as Row[], vessel_positions: [stale] as unknown as Row[] });

  const result = await evaluateAisPositionForMmsi("888888888", db, NOW);
  assert.equal(result.updated, 0);
  assert.equal(shipmentsOf(db)[0]!.status, "Booked");
  assert.equal(shipmentsOf(db)[0]!.ais_pending_status, null, "stale evidence clears the stale pending candidate");
});

await test("integration: no status change across repeated evaluations means no duplicate shipment_events", async () => {
  const shipment = makeShipment({
    id: "s1",
    vessel_mmsi: "999111222",
    status: "Departed",
    actual_departure: new Date(NOW - 5 * DAY).toISOString(),
  });
  const moored = makePosition({ mmsi: "999111222", sog: 0, nav_status: "5" }); // does not qualify as still under way
  const db = makeFakeDb({ shipments: [shipment] as unknown as Row[], vessel_positions: [moored] as unknown as Row[] });

  await evaluateAisPositionForMmsi("999111222", db, NOW);
  await evaluateAisPositionForMmsi("999111222", db, NOW + MINUTE);
  await evaluateAisPositionForMmsi("999111222", db, NOW + 2 * MINUTE);

  assert.equal(shipmentsOf(db)[0]!.status, "Departed");
  assert.equal(eventsOf(db).length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
