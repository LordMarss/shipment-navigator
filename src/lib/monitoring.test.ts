/**
 * Deterministic tests for monitoring-window eligibility (`monitoringInfo`) —
 * the gate every AIS-driven lifecycle decision passes through.
 *
 * Being subscribed to a vessel's AIS never makes a shipment eligible; only a
 * planned departure (window opens 48 h before it by default) or a real,
 * past-dated recorded departure does.
 *
 *   npx tsx src/lib/monitoring.test.ts
 */
import assert from "node:assert/strict";

import type { Shipment } from "@/lib/api";
import {
  DEFAULT_MONITORING_CONFIG,
  MAX_MONITORING_START_OFFSET_DAYS,
  monitoringInfo,
  monitoringOffset,
} from "@/lib/lifecycle";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-16T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function makeShipment(overrides: Partial<Shipment> = {}): Shipment {
  return {
    id: "test-shipment",
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
    planned_etd: iso(NOW + 30 * DAY),
    planned_eta: null,
    actual_departure: null,
    actual_arrival: null,
    actual_delivery: null,
    health: "On Track",
    health_reason: null,
    monitoring_state: "Scheduled",
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

const config = DEFAULT_MONITORING_CONFIG;
const state = (s: Shipment, cfg = config) => monitoringInfo(s, cfg, NOW).state;

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ok — ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL — ${name}`);
    console.error(err);
  }
}

test("default monitoring window is 48 hours before planned departure", () => {
  assert.equal(config.monitoring_start_offset_days, 2);
});

test("ETD 30 days away -> not eligible", () => {
  assert.equal(state(makeShipment({ planned_etd: iso(NOW + 30 * DAY) })), "Scheduled");
});

test("ETD 7 days away -> not eligible (the old default would have opened the window here)", () => {
  assert.notEqual(state(makeShipment({ planned_etd: iso(NOW + 7 * DAY) })), "Active Monitoring");
});

test("ETD 49 h away -> not yet; ETD exactly 48 h away -> eligible", () => {
  assert.notEqual(state(makeShipment({ planned_etd: iso(NOW + 49 * HOUR) })), "Active Monitoring");
  assert.equal(state(makeShipment({ planned_etd: iso(NOW + 48 * HOUR) })), "Active Monitoring");
});

test("ETD already passed with no recorded departure -> eligible", () => {
  assert.equal(state(makeShipment({ planned_etd: iso(NOW - 3 * DAY) })), "Active Monitoring");
});

test("a recorded actual_departure in the past legitimately opens monitoring, even with a far-off planned ETD", () => {
  const s = makeShipment({ planned_etd: iso(NOW + 30 * DAY), actual_departure: iso(NOW - 2 * HOUR) });
  assert.equal(state(s), "Active Monitoring");
});

test("a FUTURE-dated actual_departure (a typo/placeholder) does NOT bypass the window", () => {
  const s = makeShipment({ planned_etd: iso(NOW + 30 * DAY), actual_departure: iso(NOW + 5 * DAY) });
  assert.equal(state(s), "Scheduled");
});

test("no planned ETD and no recorded departure -> no window is invented, even if a stale stored state says Active", () => {
  const s = makeShipment({ planned_etd: null, monitoring_state: "Active Monitoring" });
  const info = monitoringInfo(s, config, NOW);
  assert.equal(info.state, "Scheduled");
  assert.equal(info.startsAt, null);
  assert.match(info.reason, /automation stays dormant/i);
});

test("an unparseable planned ETD is treated as no window, not as 'now'", () => {
  assert.equal(state(makeShipment({ planned_etd: "not-a-date" })), "Scheduled");
});

test("Delivered / actual_delivery -> Completed", () => {
  assert.equal(state(makeShipment({ status: "Delivered", planned_etd: iso(NOW - DAY) })), "Completed");
  assert.equal(state(makeShipment({ actual_delivery: iso(NOW - DAY) })), "Completed");
});

test("the offset is configurable per workspace and per shipment, and always bounded", () => {
  const s = makeShipment({ planned_etd: iso(NOW + 5 * DAY) });
  assert.notEqual(state(s), "Active Monitoring");
  assert.equal(state(s, { ...config, monitoring_start_offset_days: 7 }), "Active Monitoring");
  assert.equal(state({ ...s, monitoring_start_offset_days: 6 }), "Active Monitoring");

  // An absurd per-shipment override cannot open the window early beyond the cap.
  const far = makeShipment({ planned_etd: iso(NOW + 30 * DAY), monitoring_start_offset_days: 365 });
  assert.equal(monitoringOffset(far, config), MAX_MONITORING_START_OFFSET_DAYS);
  assert.notEqual(state(far), "Active Monitoring");

  // Negative / non-numeric values fall back to the default rather than misbehave.
  assert.equal(monitoringOffset(makeShipment({ monitoring_start_offset_days: -3 }), config), config.monitoring_start_offset_days);
  assert.equal(
    monitoringOffset(makeShipment(), { ...config, monitoring_start_offset_days: Number.NaN }),
    config.monitoring_start_offset_days,
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
