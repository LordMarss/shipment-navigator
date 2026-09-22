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

import type { Port, Shipment, VesselPosition } from "@/lib/api";
import { AIS_CONFIRMATION_MINUTES } from "@/lib/aisAutomation";
import { evaluateAisPositionForMmsi } from "@/lib/aisWebhook.server";
import { handleAisPositionWebhook } from "@/routes/api/public/hooks/ais-position";
import { makeFakeDb, type Row } from "@/lib/testkit/fakeDb";

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

function makePort(overrides: Partial<Port> = {}): Port {
  return {
    id: "port-1",
    name: "Test Port",
    unlocode: "ZZTST",
    country: "Testland",
    latitude: 30,
    longitude: 120,
    geofence_radius_km: 20,
    port_type: "general",
    source: "manual_seed",
    source_identifier: null,
    active: true,
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    ...overrides,
  };
}

/** The point `km` from `port` along `bearingDeg` — so fixtures state real distances/directions. */
function pointAt(port: Pick<Port, "latitude" | "longitude">, km: number, bearingDeg: number) {
  const d = km / 6371;
  const br = (bearingDeg * Math.PI) / 180;
  const lat1 = (port.latitude * Math.PI) / 180;
  const lon1 = (port.longitude * Math.PI) / 180;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br));
  const lon2 =
    lon1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { latitude: (lat2 * 180) / Math.PI, longitude: (lon2 * 180) / Math.PI };
}

// Origin (20 km radius -> departure area 20..80 km) and a separate destination.
const ORIGIN_PORT = makePort({ id: "origin-port", name: "Origin Port", unlocode: "ZZORG" });
const DESTINATION_PORT = makePort({ id: "dest-port", name: "Destination Port", unlocode: "ZZDST", latitude: 10, longitude: 10 });

/** Under way 30 km from the origin, heading directly away — genuine departure evidence. */
const departingPosition = (mmsi: string, overrides: Partial<VesselPosition> = {}) =>
  makePosition({ mmsi, ...pointAt(ORIGIN_PORT, 30, 90), sog: 8, nav_status: "0", cog: 90, ...overrides });

type EventRow = { source: string };

// The shared in-memory fake (with an emulation of the Phase 2 database
// functions, proven equivalent to the real SQL in transitions.db.test.ts).
type FakeDb = ReturnType<typeof makeFakeDb>;

/** Typed views over the fake db's tables, so assertions read naturally instead of via bracket access on Record<string, unknown>. */
function shipmentsOf(db: FakeDb): Shipment[] {
  return db.tables["shipments"] as unknown as Shipment[];
}
function positionsOf(db: FakeDb): VesselPosition[] {
  return db.tables["vessel_positions"] as unknown as VesselPosition[];
}
function eventsOf(db: FakeDb): EventRow[] {
  return db.tables["shipment_events"] as unknown as EventRow[];
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
//
// These run the real evaluator against the fake db and verify the Phase 1
// rules survive the plumbing: the shipment's linked origin/destination ports
// are actually loaded and used, and the debounce counts distinct AIS
// observations rather than delivery time.

const asRows = (...xs: unknown[]) => xs as unknown as Row[];

await test("integration: qualifying first observation (origin linked, vessel departing) creates a pending candidate, no status change", async () => {
  const shipment = makeShipment({ id: "s1", vessel_mmsi: "444444444", status: "Booked", origin_port_id: ORIGIN_PORT.id });
  const db = makeFakeDb({
    shipments: asRows(shipment),
    ports: asRows(ORIGIN_PORT),
    vessel_positions: asRows(departingPosition("444444444")),
  });

  const result = await evaluateAisPositionForMmsi("444444444", db, NOW);
  assert.equal(result.updated, 0);

  const stored = shipmentsOf(db)[0]!;
  assert.equal(stored.ais_pending_status, "Departed");
  assert.equal(stored.ais_pending_since, new Date(NOW).toISOString(), "pending starts at the position's own timestamp");
  assert.equal(stored.status, "Booked");
  assert.equal(eventsOf(db).length, 0, "no event yet — nothing confirmed");
});

await test("integration: the SAME movement with NO origin port linked never creates a Departed candidate", async () => {
  const shipment = makeShipment({ id: "s1", vessel_mmsi: "444000444", status: "Booked", origin_port_id: null });
  const db = makeFakeDb({
    shipments: asRows(shipment),
    ports: asRows(ORIGIN_PORT), // exists, but this shipment isn't linked to it
    vessel_positions: asRows(departingPosition("444000444")),
  });

  await evaluateAisPositionForMmsi("444000444", db, NOW);
  await evaluateAisPositionForMmsi("444000444", db, NOW + 30 * MINUTE);
  assert.equal(shipmentsOf(db)[0]!.ais_pending_status, null);
  assert.equal(shipmentsOf(db)[0]!.status, "Booked");
  assert.equal(eventsOf(db).length, 0);
});

await test("integration: repeated identical webhook does not promote early and creates no event", async () => {
  const shipment = makeShipment({ id: "s1", vessel_mmsi: "555555555", status: "Booked", origin_port_id: ORIGIN_PORT.id });
  const db = makeFakeDb({
    shipments: asRows(shipment),
    ports: asRows(ORIGIN_PORT),
    vessel_positions: asRows(departingPosition("555555555")),
  });

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

await test("integration: the SAME position re-delivered 20 minutes later does not confirm (distinct observations required)", async () => {
  const shipment = makeShipment({ id: "s1", vessel_mmsi: "555000555", status: "Booked", origin_port_id: ORIGIN_PORT.id });
  const db = makeFakeDb({
    shipments: asRows(shipment),
    ports: asRows(ORIGIN_PORT),
    vessel_positions: asRows(departingPosition("555000555")),
  });

  await evaluateAisPositionForMmsi("555000555", db, NOW);
  // Nothing about the stored position changes — only the wall clock moves on.
  const result = await evaluateAisPositionForMmsi("555000555", db, NOW + 20 * MINUTE);
  assert.equal(result.updated, 0);
  assert.equal(shipmentsOf(db)[0]!.status, "Booked", "a replay is not a second observation");
  assert.equal(eventsOf(db).length, 0);
});

await test("integration: a distinct second observation after 15+ minutes promotes and records exactly one event", async () => {
  const shipment = makeShipment({ id: "s1", vessel_mmsi: "666666666", status: "Booked", origin_port_id: ORIGIN_PORT.id });
  const db = makeFakeDb({
    shipments: asRows(shipment),
    ports: asRows(ORIGIN_PORT),
    vessel_positions: asRows(departingPosition("666666666")),
  });

  await evaluateAisPositionForMmsi("666666666", db, NOW);
  assert.equal(shipmentsOf(db)[0]!.status, "Booked", "not yet — only one observation so far");

  const later = NOW + (AIS_CONFIRMATION_MINUTES + 1) * MINUTE;
  // A genuinely new AIS report: new timestamp, vessel a little further out.
  const second = departingPosition("666666666", {
    ...pointAt(ORIGIN_PORT, 38, 90),
    position_timestamp: new Date(later).toISOString(),
    received_at: new Date(later).toISOString(),
  });
  Object.assign(positionsOf(db)[0]!, second);
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
  const shipment = makeShipment({ id: "s1", vessel_mmsi: "777777777", status: "Booked", origin_port_id: ORIGIN_PORT.id });
  const moored = makePosition({ mmsi: "777777777", sog: 0.1, nav_status: "5" });
  const db = makeFakeDb({ shipments: asRows(shipment), ports: asRows(ORIGIN_PORT), vessel_positions: asRows(moored) });

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
    origin_port_id: ORIGIN_PORT.id,
    ais_pending_status: "Departed",
    ais_pending_since: new Date(NOW - 20 * MINUTE).toISOString(), // already past the confirmation window
  });
  const stale = departingPosition("888888888", { position_timestamp: new Date(NOW - 48 * 3_600_000).toISOString() });
  const db = makeFakeDb({ shipments: asRows(shipment), ports: asRows(ORIGIN_PORT), vessel_positions: asRows(stale) });

  const result = await evaluateAisPositionForMmsi("888888888", db, NOW);
  assert.equal(result.updated, 0);
  assert.equal(shipmentsOf(db)[0]!.status, "Booked");
  assert.equal(shipmentsOf(db)[0]!.ais_pending_status, null, "stale evidence clears the stale pending candidate");
});

await test("integration: a position 45 minutes old (inside the old 24 h window) cannot confirm a due candidate", async () => {
  const shipment = makeShipment({
    id: "s1",
    vessel_mmsi: "888000888",
    status: "Booked",
    origin_port_id: ORIGIN_PORT.id,
    ais_pending_status: "Departed",
    ais_pending_since: new Date(NOW - 60 * MINUTE).toISOString(),
  });
  const old = departingPosition("888000888", {
    position_timestamp: new Date(NOW - 45 * MINUTE).toISOString(),
    received_at: new Date(NOW - 45 * MINUTE).toISOString(),
  });
  const db = makeFakeDb({ shipments: asRows(shipment), ports: asRows(ORIGIN_PORT), vessel_positions: asRows(old) });

  const result = await evaluateAisPositionForMmsi("888000888", db, NOW);
  assert.equal(result.updated, 0);
  assert.equal(shipmentsOf(db)[0]!.status, "Booked");
});

await test("integration: Arrived needs a linked destination port — a moored vessel with none never becomes Arrived", async () => {
  const shipment = makeShipment({ id: "s1", vessel_mmsi: "999000111", status: "Approaching Destination", destination_port_id: null });
  const moored = makePosition({ mmsi: "999000111", ...pointAt(DESTINATION_PORT, 3, 45), sog: 0, nav_status: "5" });
  const db = makeFakeDb({ shipments: asRows(shipment), ports: asRows(DESTINATION_PORT), vessel_positions: asRows(moored) });

  await evaluateAisPositionForMmsi("999000111", db, NOW);
  await evaluateAisPositionForMmsi("999000111", db, NOW + 30 * MINUTE);
  assert.equal(shipmentsOf(db)[0]!.status, "Approaching Destination");
  assert.equal(shipmentsOf(db)[0]!.ais_pending_status, null);
  assert.equal(eventsOf(db).length, 0);
});

await test("integration: with a destination port linked, moored inside the geofence sets a pending Arrived candidate", async () => {
  const shipment = makeShipment({
    id: "s1",
    vessel_mmsi: "999000222",
    status: "Approaching Destination",
    destination_port_id: DESTINATION_PORT.id,
  });
  const moored = makePosition({ mmsi: "999000222", ...pointAt(DESTINATION_PORT, 3, 45), sog: 0, nav_status: "5" });
  const db = makeFakeDb({ shipments: asRows(shipment), ports: asRows(DESTINATION_PORT), vessel_positions: asRows(moored) });

  await evaluateAisPositionForMmsi("999000222", db, NOW);
  assert.equal(shipmentsOf(db)[0]!.ais_pending_status, "Arrived");
  assert.equal(shipmentsOf(db)[0]!.status, "Approaching Destination");
});

await test("integration: ETD 30 days away -> the vessel's AIS does nothing to the shipment", async () => {
  const shipment = makeShipment({
    id: "s1",
    vessel_mmsi: "999000333",
    status: "Booked",
    origin_port_id: ORIGIN_PORT.id,
    planned_etd: new Date(NOW + 30 * DAY).toISOString(),
    monitoring_state: "Scheduled",
  });
  const db = makeFakeDb({
    shipments: asRows(shipment),
    ports: asRows(ORIGIN_PORT),
    vessel_positions: asRows(departingPosition("999000333")),
  });

  const result = await evaluateAisPositionForMmsi("999000333", db, NOW);
  assert.equal(result.updated, 0);
  assert.equal(shipmentsOf(db)[0]!.status, "Booked");
  assert.equal(shipmentsOf(db)[0]!.ais_pending_status, null);
  assert.equal(eventsOf(db).length, 0);
});

await test("integration: no status change across repeated evaluations means no duplicate shipment_events", async () => {
  const shipment = makeShipment({
    id: "s1",
    vessel_mmsi: "999111222",
    status: "Departed",
    actual_departure: new Date(NOW - 5 * DAY).toISOString(),
  });
  const moored = makePosition({ mmsi: "999111222", sog: 0, nav_status: "5" }); // does not qualify as still under way
  const db = makeFakeDb({ shipments: asRows(shipment), vessel_positions: asRows(moored) });

  await evaluateAisPositionForMmsi("999111222", db, NOW);
  await evaluateAisPositionForMmsi("999111222", db, NOW + MINUTE);
  await evaluateAisPositionForMmsi("999111222", db, NOW + 2 * MINUTE);

  assert.equal(shipmentsOf(db)[0]!.status, "Departed");
  assert.equal(eventsOf(db).length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
