/**
 * Deterministic fixture-based tests for the date/time-based automation
 * fallback (`deriveAutomation`), and specifically for the `hasFreshAis`
 * guard that stops it from advancing a shipment's lifecycle purely on
 * elapsed time when fresh AIS data exists for that vessel.
 *
 * No live AIS, no database — pure function in, decision object out. Run
 * directly with a TS-aware runner that understands the tsconfig path alias:
 *   npx tsx src/lib/autoStatus.test.ts
 */
import assert from "node:assert/strict";

import { ACTIVE_STATUSES, type Shipment } from "@/lib/api";
import { DEFAULT_MONITORING_CONFIG } from "@/lib/lifecycle";
import { deriveAutomation, IN_TRANSIT_AFTER_HOURS } from "@/lib/autoStatus";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-16T12:00:00Z");

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
    status: "Departed",
    eta: null,
    previous_eta: null,
    planned_etd: new Date(NOW - 2 * DAY).toISOString(),
    planned_eta: null,
    // Well past IN_TRANSIT_AFTER_HOURS by default, so the elapsed-time rule
    // would advance to In Transit unless the fresh-AIS guard stops it.
    actual_departure: new Date(NOW - (IN_TRANSIT_AFTER_HOURS + 24) * HOUR).toISOString(),
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

const config = DEFAULT_MONITORING_CONFIG;

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

// 1. No MMSI + elapsed time → date automation can advance.
test("1: no MMSI, elapsed time past threshold advances to In Transit", () => {
  const shipment = makeShipment({ vessel_mmsi: null });
  const decision = deriveAutomation(shipment, config, false, NOW);
  assert.equal(decision.status, "In Transit");
  assert.equal(decision.statusChanged, true);
  assert.equal(decision.source, "system");
});

// 2. MMSI + no fresh AIS → date automation can still advance as fallback.
test("2: MMSI present but no fresh AIS (hasFreshAis=false) still advances as fallback", () => {
  const shipment = makeShipment({ vessel_mmsi: "123456789" });
  const decision = deriveAutomation(shipment, config, false, NOW);
  assert.equal(decision.status, "In Transit");
  assert.equal(decision.statusChanged, true);
});

// 3. MMSI + fresh AIS (vessel underway per the caller's freshness check) →
//    date automation must NOT blindly advance; it defers to AIS entirely.
test("3: MMSI + fresh AIS present does NOT advance on elapsed time alone", () => {
  const shipment = makeShipment({ vessel_mmsi: "123456789" });
  const decision = deriveAutomation(shipment, config, true, NOW);
  assert.equal(decision.status, "Departed", "status must stay exactly as stored");
  assert.equal(decision.statusChanged, false);
  assert.match(decision.reason, /deferring lifecycle decisions to AIS automation/i);
});

// 4. Same guard applies regardless of what the (out-of-scope-here) AIS data
//    actually shows — `hasFreshAis` alone is what matters to this pipeline,
//    since a vessel confirmed stopped is exactly the case Fix 1 must not
//    contradict by advancing on elapsed time.
test("4: MMSI + fresh AIS present (vessel actually stopped) still does NOT advance", () => {
  const shipment = makeShipment({ vessel_mmsi: "123456789", status: "In Transit" });
  const decision = deriveAutomation(shipment, config, true, NOW);
  assert.equal(decision.status, "In Transit");
  assert.equal(decision.statusChanged, false);
});

// 5. An actual recorded arrival remains authoritative regardless of the
//    fresh-AIS guard — it is a real fact, not a time-elapsed guess.
test("5: actual_arrival wins even when hasFreshAis is true", () => {
  const shipment = makeShipment({ actual_arrival: new Date(NOW).toISOString() });
  const decision = deriveAutomation(shipment, config, true, NOW);
  assert.equal(decision.status, "Arrived");
  assert.equal(decision.statusChanged, true);
});

// 6. Legacy statuses remain frozen regardless of the fresh-AIS guard.
test("6: legacy status stays frozen whether or not fresh AIS exists", () => {
  const shipment = makeShipment({ status: "Cleared Customs" });
  assert.equal(deriveAutomation(shipment, config, true, NOW).statusChanged, false);
  assert.equal(deriveAutomation(shipment, config, false, NOW).statusChanged, false);
});

// 7. The guard never regresses a status that is already ahead of where
//    elapsed time alone would put it (e.g. a prior manual override) — the
//    same never-regress invariant the AIS pipeline itself guarantees.
test("7: a status already advanced past what elapsed time implies is left alone", () => {
  const shipment = makeShipment({
    status: "Approaching Destination",
    actual_departure: new Date(NOW - 1 * HOUR).toISOString(), // barely departed
  });
  const decision = deriveAutomation(shipment, config, false, NOW);
  assert.equal(decision.status, "Approaching Destination");
  assert.equal(decision.statusChanged, false);
});

// 8. The six customer-facing lifecycle statuses are unchanged by this work.
test("8: the active lifecycle is exactly the six expected statuses, in order", () => {
  assert.deepEqual(ACTIVE_STATUSES, [
    "Scheduled",
    "Booked",
    "Departed",
    "In Transit",
    "Approaching Destination",
    "Arrived",
  ]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
