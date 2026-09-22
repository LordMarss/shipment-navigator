/**
 * Integration tests for the daily sweep (`runAutomationSweep`) against a small
 * in-memory fake Db. This is the path that used to advance statuses from the
 * calendar whenever AIS looked stale; it must now never do so.
 *
 *   npx tsx src/lib/automation.server.test.ts
 */
import assert from "node:assert/strict";

import type { Db, Shipment, VesselPosition } from "@/lib/api";
import { runAutomationSweep } from "@/lib/automation.server";
import { makeFakeDb, type Row } from "@/lib/testkit/fakeDb";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;
const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
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

function makeShipment(overrides: Partial<Shipment> = {}): Shipment {
  return {
    id: "s1",
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
    planned_etd: iso(NOW - 3 * DAY),
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
    updated_at: iso(NOW),
    created_at: iso(NOW),
    ...overrides,
  };
}

function makePosition(overrides: Partial<VesselPosition> = {}): VesselPosition {
  return {
    mmsi: "123456789",
    vessel_name: "Test Vessel",
    latitude: 31.2,
    longitude: 121.5,
    sog: 14,
    cog: 90,
    true_heading: null,
    nav_status: "0",
    position_timestamp: iso(NOW),
    received_at: iso(NOW),
    source: "aisstream",
    updated_at: iso(NOW),
    ...overrides,
  };
}

// --- adapter over the shared fake ----------------------------------------------

function makeSweepDb(seed: { shipments: Shipment[]; positions?: VesselPosition[] }) {
  const fake = makeFakeDb({
    shipments: seed.shipments as unknown as Row[],
    vessel_positions: (seed.positions ?? []) as unknown as Row[],
  });
  return {
    db: fake as unknown as Db,
    shipments: () => fake.tables["shipments"] as unknown as Shipment[],
    events: () => fake.tables["shipment_events"] as Array<{ event_type: string; to_value: string | null; source: string }>,
  };
}

// --- the clock never advances status -----------------------------------------

await test("ETD passed + NO position at all -> status unchanged, no event", async () => {
  const f = makeSweepDb({ shipments: [makeShipment({ status: "Booked" })] });
  const result = await runAutomationSweep(f.db);
  assert.equal(result.evaluated, 1);
  assert.equal(result.updated, 0);
  assert.equal(f.shipments()[0]!.status, "Booked");
  assert.equal(f.events().length, 0);
});

await test("ETD passed + a position older than the 30 min lifecycle window -> status unchanged (stale AIS is not evidence, and nor is the calendar)", async () => {
  const stale = makePosition({ position_timestamp: iso(NOW - 45 * MINUTE), received_at: iso(NOW - 45 * MINUTE) });
  const f = makeSweepDb({ shipments: [makeShipment({ status: "Booked" })], positions: [stale] });
  const result = await runAutomationSweep(f.db);
  assert.equal(result.updated, 0);
  assert.equal(f.shipments()[0]!.status, "Booked");
  assert.equal(f.events().length, 0);
});

await test("a 26 h-old position (the old 'stale' line) + long-past ETD/ETA -> nothing advances, however overdue", async () => {
  const stale = makePosition({ position_timestamp: iso(NOW - 26 * HOUR), received_at: iso(NOW - 26 * HOUR) });
  const overdue = makeShipment({
    status: "Departed",
    planned_etd: iso(NOW - 10 * DAY),
    actual_departure: iso(NOW - 8 * DAY),
    eta: iso(NOW - 2 * DAY),
  });
  const f = makeSweepDb({ shipments: [overdue], positions: [stale] });
  await runAutomationSweep(f.db);
  assert.equal(f.shipments()[0]!.status, "Departed", "no In Transit / Approaching / Arrived from elapsed time");
  assert.equal(f.events().filter((e) => e.event_type === "status_auto").length, 0);
});

await test("ETA within 48 h + no AIS -> does not advance to Approaching Destination", async () => {
  const s = makeShipment({ status: "In Transit", actual_departure: iso(NOW - 5 * DAY), eta: iso(NOW + 20 * HOUR) });
  const f = makeSweepDb({ shipments: [s] });
  await runAutomationSweep(f.db);
  assert.equal(f.shipments()[0]!.status, "In Transit");
});

await test("fresh AIS present -> the sweep still does not move status (AIS automation owns that)", async () => {
  const f = makeSweepDb({ shipments: [makeShipment({ status: "Booked" })], positions: [makePosition()] });
  const result = await runAutomationSweep(f.db);
  assert.equal(result.updated, 0);
  assert.equal(f.shipments()[0]!.status, "Booked");
});

// --- what the sweep legitimately still does -----------------------------------

await test("a recorded actual_arrival is still applied (an operator fact), with exactly one system event", async () => {
  const f = makeSweepDb({ shipments: [makeShipment({ status: "In Transit", actual_arrival: iso(NOW - HOUR) })] });
  const result = await runAutomationSweep(f.db);
  assert.equal(result.updated, 1);
  assert.equal(f.shipments()[0]!.status, "Arrived");
  const events = f.events().filter((e) => e.event_type === "status_auto");
  assert.equal(events.length, 1);
  assert.equal(events[0]!.source, "system");
});

await test("a recorded past actual_departure moves Booked -> Departed and nothing further", async () => {
  const f = makeSweepDb({
    shipments: [makeShipment({ status: "Booked", actual_departure: iso(NOW - 6 * DAY), eta: iso(NOW + 10 * HOUR) })],
  });
  await runAutomationSweep(f.db);
  assert.equal(f.shipments()[0]!.status, "Departed");
});

await test("monitoring state is still kept current (Scheduled -> Active Monitoring inside the window) without touching status", async () => {
  const f = makeSweepDb({ shipments: [makeShipment({ status: "Booked", monitoring_state: "Scheduled" })] });
  await runAutomationSweep(f.db);
  assert.equal(f.shipments()[0]!.monitoring_state, "Active Monitoring");
  assert.equal(f.shipments()[0]!.status, "Booked");
  assert.equal(f.events().filter((e) => e.event_type === "monitoring_auto").length, 1);
});

await test("a shipment with no planned ETD and a stale stored 'Active Monitoring' is stood down to Scheduled", async () => {
  const f = makeSweepDb({ shipments: [makeShipment({ planned_etd: null, monitoring_state: "Active Monitoring" })] });
  await runAutomationSweep(f.db);
  assert.equal(f.shipments()[0]!.monitoring_state, "Scheduled");
  assert.equal(f.shipments()[0]!.status, "Booked");
});

await test("the sweep stamps last_synced_at on every evaluated shipment, and is idempotent (second run adds no events)", async () => {
  const f = makeSweepDb({ shipments: [makeShipment({ status: "Booked" })] });
  await runAutomationSweep(f.db);
  assert.ok(f.shipments()[0]!.last_synced_at);
  const before = f.events().length;
  await runAutomationSweep(f.db);
  assert.equal(f.events().length, before);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
