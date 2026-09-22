/**
 * Deterministic fixture-based tests for the date-based automation
 * (`deriveAutomation`, the daily sweep's half of the pipeline).
 *
 * The rule under test: the calendar never changes a lifecycle status. A
 * planned departure passing, time since departure, an ETA approaching or
 * passing — none of it advances a shipment; each only produces an
 * explanation ("no AIS evidence has been received") for the operator. Only
 * facts an operator has explicitly RECORDED (an actual arrival, a past-dated
 * actual departure) are applied. Status progression from vessel movement
 * belongs to `deriveAisAutomation()` and requires fresh AIS.
 *
 * No live AIS, no database — pure function in, decision object out. Run
 * directly with a TS-aware runner that understands the tsconfig path alias:
 *   npx tsx src/lib/autoStatus.test.ts
 */
import assert from "node:assert/strict";

import { ACTIVE_STATUSES, type Shipment } from "@/lib/api";
import { DEFAULT_MONITORING_CONFIG } from "@/lib/lifecycle";
import { APPROACHING_WITHIN_HOURS, deriveAutomation } from "@/lib/autoStatus";

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
    // Inside the monitoring window, planned departure 2 days ago.
    planned_etd: iso(NOW - 2 * DAY),
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

// --- The clock never advances a status -------------------------------------

test("1: ETD passed + no AIS -> Booked stays Booked, and the reason says why", () => {
  const shipment = makeShipment({ status: "Booked", vessel_mmsi: "123456789" });
  const decision = deriveAutomation(shipment, config, false, NOW);
  assert.equal(decision.status, "Booked");
  assert.equal(decision.statusChanged, false);
  assert.match(decision.reason, /planned departure has passed but no AIS departure evidence has been received/i);
});

test("2: ETD passed + no vessel MMSI -> still no advance; reason says departure cannot be detected", () => {
  const shipment = makeShipment({ status: "Booked", vessel_mmsi: null });
  const decision = deriveAutomation(shipment, config, false, NOW);
  assert.equal(decision.statusChanged, false);
  assert.equal(decision.status, "Booked");
  assert.match(decision.reason, /no vessel MMSI is linked/i);
});

test("3: a long time since departure never advances Departed -> In Transit", () => {
  const shipment = makeShipment({
    status: "Departed",
    planned_etd: iso(NOW - 10 * DAY),
    // A recorded departure days ago: the old rule (24 h since departure) would have advanced this.
    actual_departure: iso(NOW - 5 * DAY),
    eta: iso(NOW + 20 * DAY),
  });
  const decision = deriveAutomation(shipment, config, false, NOW);
  assert.equal(decision.status, "Departed");
  assert.equal(decision.statusChanged, false);
});

test("4: ETA within the 48 h window + no AIS -> does not advance to Approaching Destination", () => {
  for (const status of ["Departed", "In Transit"] as const) {
    const shipment = makeShipment({
      status,
      actual_departure: iso(NOW - 5 * DAY),
      eta: iso(NOW + (APPROACHING_WITHIN_HOURS - 10) * HOUR),
    });
    const decision = deriveAutomation(shipment, config, false, NOW);
    assert.equal(decision.status, status, `${status} must stay ${status}`);
    assert.equal(decision.statusChanged, false);
    assert.match(decision.reason, /ETA is within 48h but no AIS approach evidence/i);
  }
});

test("5: elapsed time / a passed ETA never produces Arrived", () => {
  const shipment = makeShipment({
    status: "Approaching Destination",
    actual_departure: iso(NOW - 12 * DAY),
    eta: iso(NOW - 5 * DAY), // ETA passed five days ago
  });
  const decision = deriveAutomation(shipment, config, false, NOW);
  assert.equal(decision.status, "Approaching Destination");
  assert.equal(decision.statusChanged, false);
  assert.match(decision.reason, /ETA has passed but no AIS arrival evidence/i);
});

test("6: stale/absent AIS is indistinguishable from no AIS here — nothing advances (the caller passes hasFreshAis=false for a position older than the lifecycle window)", () => {
  for (const status of ["Booked", "Departed", "In Transit", "Approaching Destination"] as const) {
    const shipment = makeShipment({ status, actual_departure: null, eta: iso(NOW - DAY) });
    const decision = deriveAutomation(shipment, config, false, NOW);
    assert.equal(decision.statusChanged, false, status);
    assert.equal(decision.status, status);
  }
});

test("7: with fresh AIS (and everything AIS needs linked) the reason defers to AIS automation and status is untouched", () => {
  const shipment = makeShipment({ status: "In Transit", actual_departure: iso(NOW - 5 * DAY), destination_port_id: "port-dest" });
  const decision = deriveAutomation(shipment, config, true, NOW);
  assert.equal(decision.status, "In Transit");
  assert.equal(decision.statusChanged, false);
  assert.match(decision.reason, /deferring lifecycle decisions to AIS automation/i);
  assert.equal(decision.automation, "active");
});

// --- Port-not-linked visibility (Phase 2) -----------------------------------
// "Automation active" must be distinguishable from "paused / insufficient
// evidence", carried in the existing reason/monitoring fields — no new UI.

test("7a: Booked with no origin port linked -> insufficient evidence, says AIS cannot confirm departure", () => {
  const shipment = makeShipment({ status: "Booked", origin_port_id: null, planned_etd: iso(NOW + 12 * HOUR) });
  const decision = deriveAutomation(shipment, config, true, NOW);
  assert.equal(decision.automation, "insufficient_evidence");
  assert.match(decision.reason, /Origin port not linked — AIS cannot confirm departure/);
  assert.doesNotMatch(decision.reason, /deferring lifecycle decisions/i, "must not claim automation is simply active");
  assert.equal(decision.statusChanged, false);
});

test("7b: In Transit with no destination port linked -> says AIS cannot confirm the vessel is approaching it", () => {
  const shipment = makeShipment({ status: "In Transit", actual_departure: iso(NOW - 5 * DAY), destination_port_id: null });
  const decision = deriveAutomation(shipment, config, true, NOW);
  assert.equal(decision.automation, "insufficient_evidence");
  assert.match(decision.reason, /Destination port not linked — AIS cannot confirm the vessel is approaching it/);
});

test("7c: Approaching Destination with no destination port -> cannot confirm arrival", () => {
  const shipment = makeShipment({ status: "Approaching Destination", actual_departure: iso(NOW - 9 * DAY), destination_port_id: null });
  const decision = deriveAutomation(shipment, config, true, NOW);
  assert.equal(decision.automation, "insufficient_evidence");
  assert.match(decision.reason, /Destination port not linked — AIS cannot confirm arrival/);
});

test("7d: no MMSI -> the limitation is the MMSI (reported once, not also as a port problem)", () => {
  const shipment = makeShipment({ status: "Booked", vessel_mmsi: null, planned_etd: iso(NOW + 12 * HOUR) });
  const decision = deriveAutomation(shipment, config, false, NOW);
  assert.equal(decision.automation, "insufficient_evidence");
  assert.match(decision.reason, /No vessel MMSI linked/);
  assert.doesNotMatch(decision.reason, /port not linked/i);
});

test("7e: everything linked -> 'active'; the limitation notes append to (never replace) the monitoring reason", () => {
  const linked = makeShipment({ status: "Booked", origin_port_id: "port-origin", destination_port_id: "port-dest", planned_etd: iso(NOW + 12 * HOUR) });
  assert.equal(deriveAutomation(linked, config, true, NOW).automation, "active");
  const unlinked = makeShipment({ status: "Booked", origin_port_id: null, planned_etd: iso(NOW + 12 * HOUR) });
  const d = deriveAutomation(unlinked, config, true, NOW);
  assert.ok(d.reason.startsWith(d.monitoringReason), "monitoring explanation is preserved at the front");
});

test("7f: an overdue departure AND an unlinked origin are both said, once each", () => {
  const shipment = makeShipment({ status: "Booked", origin_port_id: null, planned_etd: iso(NOW - 2 * DAY) });
  const d = deriveAutomation(shipment, config, false, NOW);
  assert.match(d.reason, /Origin port not linked/);
  assert.match(d.reason, /no AIS departure evidence has been received/i);
});

test("7g: dormant before the window opens — no limitation notes are shown for a shipment automation is not yet watching", () => {
  const shipment = makeShipment({ status: "Booked", planned_etd: iso(NOW + 30 * DAY), monitoring_state: "Scheduled", origin_port_id: null });
  const d = deriveAutomation(shipment, config, false, NOW);
  assert.equal(d.automation, "dormant");
  assert.doesNotMatch(d.reason, /port not linked/i);
});

// --- Operator hold (Phase 2) -------------------------------------------------

test("7h: an operator hold pauses even a recorded-fact advance, and says when it resumes", () => {
  const holdUntil = iso(NOW + 4 * HOUR);
  const shipment = makeShipment({ status: "In Transit", actual_arrival: iso(NOW - HOUR), automation_hold_until: holdUntil });
  const d = deriveAutomation(shipment, config, false, NOW);
  assert.equal(d.status, "In Transit", "the operator's correction is not undone by a recorded arrival");
  assert.equal(d.statusChanged, false);
  assert.equal(d.automation, "paused");
  assert.match(d.reason, /Automation paused after a manual status correction until 2026-09-16 16:00 UTC/);
});

test("7h2: a hold is reported even before the monitoring window opens (so an operator can see and lift it)", () => {
  const shipment = makeShipment({
    status: "Booked",
    planned_etd: iso(NOW + 30 * DAY),
    monitoring_state: "Scheduled",
    automation_hold_until: iso(NOW + 4 * HOUR),
  });
  const d = deriveAutomation(shipment, config, false, NOW);
  assert.equal(d.automation, "paused");
  assert.match(d.reason, /Automation paused after a manual status correction until 2026-09-16 16:00 UTC/);
});

test("7i: once the hold has expired, the recorded fact applies again", () => {
  const shipment = makeShipment({ status: "In Transit", actual_arrival: iso(NOW - HOUR), automation_hold_until: iso(NOW - 1000) });
  const d = deriveAutomation(shipment, config, false, NOW);
  assert.equal(d.status, "Arrived");
  assert.equal(d.statusChanged, true);
  assert.equal(d.evidenceAt, shipment.actual_arrival);
});

test("7j: a recorded departure carries its own timestamp as evidenceAt (the identity of that logical transition)", () => {
  const shipment = makeShipment({ status: "Booked", actual_departure: iso(NOW - 6 * DAY) });
  const d = deriveAutomation(shipment, config, false, NOW);
  assert.equal(d.status, "Departed");
  assert.equal(d.evidenceAt, shipment.actual_departure);
  assert.equal(deriveAutomation(makeShipment({ status: "Booked" }), config, false, NOW).evidenceAt, null);
});

test("7k: a monitoring-state change keeps its own reason, separate from the lifecycle explanation", () => {
  const shipment = makeShipment({ status: "Booked", monitoring_state: "Scheduled", planned_etd: iso(NOW + 12 * HOUR), origin_port_id: null });
  const d = deriveAutomation(shipment, config, false, NOW);
  assert.equal(d.monitoringChanged, true);
  assert.doesNotMatch(d.monitoringReason, /port not linked/i);
  assert.notEqual(d.monitoringReason, d.reason);
});

// --- Operator-recorded facts are still applied -----------------------------

test("8: a recorded actual_arrival is authoritative, regardless of AIS", () => {
  const shipment = makeShipment({ status: "In Transit", actual_arrival: iso(NOW) });
  for (const fresh of [true, false]) {
    const decision = deriveAutomation(shipment, config, fresh, NOW);
    assert.equal(decision.status, "Arrived");
    assert.equal(decision.statusChanged, true);
    assert.equal(decision.source, "system");
  }
});

test("9: a recorded, past-dated actual_departure moves Booked -> Departed (an operator fact, not a guess) — and only that far", () => {
  const shipment = makeShipment({ status: "Booked", actual_departure: iso(NOW - 6 * DAY), eta: iso(NOW + 1 * DAY) });
  const decision = deriveAutomation(shipment, config, false, NOW);
  assert.equal(decision.status, "Departed", "not In Transit, not Approaching — the clock adds nothing");
  assert.equal(decision.statusChanged, true);
});

test("10: a FUTURE-dated actual_departure is not a departure — ignored, status unchanged", () => {
  const shipment = makeShipment({ status: "Booked", planned_etd: iso(NOW + 30 * DAY), actual_departure: iso(NOW + 10 * DAY), monitoring_state: "Scheduled" });
  const decision = deriveAutomation(shipment, config, false, NOW);
  assert.equal(decision.status, "Booked");
  assert.equal(decision.statusChanged, false);
  assert.notEqual(decision.monitoring_state, "Active Monitoring");
});

test("11: nothing runs before the monitoring window opens", () => {
  const shipment = makeShipment({ status: "Booked", planned_etd: iso(NOW + 30 * DAY), monitoring_state: "Scheduled" });
  const decision = deriveAutomation(shipment, config, false, NOW);
  assert.equal(decision.statusChanged, false);
  assert.equal(decision.monitoringChanged, false);
  assert.doesNotMatch(decision.reason, /no AIS/i, "no overdue note for a shipment that is not yet due");
});

// --- Unchanged guarantees ---------------------------------------------------

test("12: legacy statuses remain frozen", () => {
  const shipment = makeShipment({ status: "Cleared Customs" });
  assert.equal(deriveAutomation(shipment, config, true, NOW).statusChanged, false);
  assert.equal(deriveAutomation(shipment, config, false, NOW).statusChanged, false);
});

test("13: never regresses a status that is ahead of any recorded fact", () => {
  const shipment = makeShipment({ status: "Approaching Destination", actual_departure: iso(NOW - 1 * HOUR) });
  const decision = deriveAutomation(shipment, config, false, NOW);
  assert.equal(decision.status, "Approaching Destination");
  assert.equal(decision.statusChanged, false);
});

test("14: the six customer-facing lifecycle statuses are unchanged", () => {
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
