/**
 * Deterministic fixture-based tests for the Phase 3 AIS decision layer.
 * No live AIS, no database — pure function in, decision object out.
 *
 * Not wired into any test runner (none exists in this repo yet); run
 * directly with a TS-aware runner that understands the tsconfig path alias:
 *   npx tsx src/lib/aisAutomation.test.ts
 */
import assert from "node:assert/strict";

import { ACTIVE_STATUSES, type ActiveShipmentStatus, type Port, type Shipment, type VesselPosition } from "@/lib/api";
import { DEFAULT_MONITORING_CONFIG } from "@/lib/lifecycle";
import {
  AIS_CONFIRMATION_MINUTES,
  AIS_PENDING_MAX_AGE_MINUTES,
  deriveAisAutomation,
  deriveVesselCondition,
  vesselConditionLabel,
} from "@/lib/aisAutomation";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;
const NOW = Date.parse("2026-09-16T12:00:00Z");

const rank = (s: ActiveShipmentStatus) => ACTIVE_STATUSES.indexOf(s);

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
    // In the active monitoring window by default: planned departure already passed.
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
    sog: 0,
    cog: null,
    true_heading: null,
    nav_status: "5", // moored
    position_timestamp: new Date(NOW).toISOString(),
    received_at: new Date(NOW).toISOString(),
    source: "aisstream",
    updated_at: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function makePort(overrides: Partial<Port> = {}): Port {
  return {
    id: "test-port",
    name: "Test Port",
    unlocode: "ZZTST",
    country: "Testland",
    latitude: 10,
    longitude: 10,
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

const config = DEFAULT_MONITORING_CONFIG;
const DESTINATION_PORT = makePort();
// ~7.8km from DESTINATION_PORT — inside its 20km geofence.
const INSIDE_GEOFENCE = { latitude: 10.05, longitude: 10.05 };
// ~78km from DESTINATION_PORT — outside the 20km geofence, but still an
// "intermediate port" nearby-ish, not on the other side of the planet.
const OUTSIDE_GEOFENCE = { latitude: 10.5, longitude: 10.5 };
// ~780km from DESTINATION_PORT — outside even the wide Approaching
// Destination proximity multiplier (20km * 10 = 200km).
const FAR_AWAY = { latitude: 15, longitude: 15 };

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

// A. Vessel still at origin -> does NOT become Departed
test("A: vessel sitting at origin does not become Departed", () => {
  const shipment = makeShipment({ status: "Booked" });
  const position = makePosition({ sog: 0.1, nav_status: "5" }); // moored, ~0 kn
  const decision = deriveAisAutomation(shipment, position, config, NOW);
  assert.equal(decision.status, "Booked");
  assert.equal(decision.statusChanged, false);
  assert.equal(decision.pendingStatus, null);
});

// B. Vessel leaves origin -> becomes Departed (after confirmation window)
test("B: vessel leaving origin becomes Departed once confirmed", () => {
  let shipment = makeShipment({ status: "Booked" });
  const underway = makePosition({ sog: 6, nav_status: "0" });

  const first = deriveAisAutomation(shipment, underway, config, NOW);
  assert.equal(first.statusChanged, false, "first observation should only set a pending candidate");
  assert.equal(first.pendingStatus, "Departed");
  assert.ok(first.pendingSince);

  shipment = { ...shipment, ais_pending_status: first.pendingStatus, ais_pending_since: first.pendingSince };
  const later = NOW + (AIS_CONFIRMATION_MINUTES + 1) * MINUTE;
  const second = deriveAisAutomation(shipment, { ...underway, position_timestamp: new Date(later).toISOString(), received_at: new Date(later).toISOString() }, config, later);
  assert.equal(second.status, "Departed");
  assert.equal(second.statusChanged, true);
  assert.equal(second.source, "ais");
  assert.equal(second.pendingStatus, null, "pending candidate is consumed once promoted");
});

// C. Vessel is underway -> becomes In Transit
test("C: vessel underway since departure becomes In Transit once confirmed", () => {
  let shipment = makeShipment({ status: "Departed", actual_departure: new Date(NOW - DAY).toISOString() });
  const underway = makePosition({ sog: 12, nav_status: "0" });

  const first = deriveAisAutomation(shipment, underway, config, NOW);
  assert.equal(first.pendingStatus, "In Transit");
  assert.equal(first.statusChanged, false);

  shipment = { ...shipment, ais_pending_status: first.pendingStatus, ais_pending_since: first.pendingSince };
  const later = NOW + (AIS_CONFIRMATION_MINUTES + 1) * MINUTE;
  const second = deriveAisAutomation(shipment, { ...underway, position_timestamp: new Date(later).toISOString() }, config, later);
  assert.equal(second.status, "In Transit");
  assert.equal(second.statusChanged, true);
  assert.equal(second.source, "ais");
});

// D. Vessel approaches destination -> becomes Approaching Destination
test("D: vessel nearing ETA becomes Approaching Destination once confirmed", () => {
  let shipment = makeShipment({ status: "In Transit", eta: new Date(NOW + 10 * HOUR).toISOString() });
  const position = makePosition({ sog: 14, nav_status: "0" });

  const first = deriveAisAutomation(shipment, position, config, NOW);
  assert.equal(first.pendingStatus, "Approaching Destination");

  shipment = { ...shipment, ais_pending_status: first.pendingStatus, ais_pending_since: first.pendingSince };
  const later = NOW + (AIS_CONFIRMATION_MINUTES + 1) * MINUTE;
  const second = deriveAisAutomation(shipment, { ...position, position_timestamp: new Date(later).toISOString() }, config, later);
  assert.equal(second.status, "Approaching Destination");
  assert.equal(second.statusChanged, true);
});

// E. Vessel reaches destination -> becomes Arrived
test("E: vessel stopping near destination becomes Arrived once confirmed", () => {
  let shipment = makeShipment({ status: "Approaching Destination", eta: new Date(NOW + 2 * HOUR).toISOString() });
  const stopped = makePosition({ sog: 0.1, nav_status: "1" }); // at anchor

  const first = deriveAisAutomation(shipment, stopped, config, NOW);
  assert.equal(first.pendingStatus, "Arrived");

  shipment = { ...shipment, ais_pending_status: first.pendingStatus, ais_pending_since: first.pendingSince };
  const later = NOW + (AIS_CONFIRMATION_MINUTES + 1) * MINUTE;
  const second = deriveAisAutomation(shipment, { ...stopped, position_timestamp: new Date(later).toISOString() }, config, later);
  assert.equal(second.status, "Arrived");
  assert.equal(second.statusChanged, true);
  assert.equal(second.source, "ais");
});

// F. Missing/stale AIS -> does not incorrectly advance status
test("F1: no AIS position at all does not advance status", () => {
  const shipment = makeShipment({ status: "Booked" });
  const decision = deriveAisAutomation(shipment, null, config, NOW);
  assert.equal(decision.statusChanged, false);
  assert.equal(decision.pendingStatus, null);
});

test("F2: stale AIS position does not advance status even with strong evidence", () => {
  const shipment = makeShipment({ status: "Booked" });
  const stalePosition = makePosition({
    sog: 15,
    nav_status: "0",
    position_timestamp: new Date(NOW - 48 * HOUR).toISOString(), // beyond AIS_STALE_HOURS
  });
  const decision = deriveAisAutomation(shipment, stalePosition, config, NOW);
  assert.equal(decision.statusChanged, false);
  assert.equal(decision.pendingStatus, null);
});

test("F3: a pending candidate is dropped if AIS goes stale before confirmation", () => {
  const shipment = makeShipment({
    status: "Booked",
    ais_pending_status: "Departed",
    ais_pending_since: new Date(NOW - 20 * MINUTE).toISOString(), // already past the confirmation window
  });
  const stalePosition = makePosition({ sog: 6, nav_status: "0", position_timestamp: new Date(NOW - 48 * HOUR).toISOString() });
  const decision = deriveAisAutomation(shipment, stalePosition, config, NOW);
  assert.equal(decision.statusChanged, false, "stale evidence must not confirm a pending candidate, even one that's overdue");
  assert.equal(decision.pendingStatus, null);
});

test("F4: a pending candidate that is itself too old does not instantly confirm on one fresh reading", () => {
  // Regression: e.g. an AIS worker outage or a long coverage gap left
  // ais_pending_since days old. A single fresh, qualifying position must
  // not be treated as if it corroborated a candidate that's been sitting
  // that long — it should restart the debounce window instead.
  const shipment = makeShipment({
    status: "Booked",
    ais_pending_status: "Departed",
    ais_pending_since: new Date(NOW - 5 * DAY).toISOString(),
  });
  const freshUnderway = makePosition({ sog: 6, nav_status: "0" }); // fresh as of NOW
  const decision = deriveAisAutomation(shipment, freshUnderway, config, NOW);
  assert.equal(decision.statusChanged, false, "a stale pending candidate must not confirm from a single fresh reading");
  assert.equal(decision.pendingStatus, "Departed");
  assert.equal(decision.pendingSince, new Date(NOW).toISOString(), "the debounce window restarts from this observation");

  // Sanity check the fix doesn't break the real confirmation path: within
  // the max-age window, the existing behavior (confirm after the minimum
  // wait) still works.
  const withinAge = { ...shipment, ais_pending_since: new Date(NOW - (AIS_PENDING_MAX_AGE_MINUTES - 5) * MINUTE).toISOString() };
  const stillConfirms = deriveAisAutomation(withinAge, freshUnderway, config, NOW);
  assert.equal(stillConfirms.status, "Departed");
  assert.equal(stillConfirms.statusChanged, true);
});

// G. No MMSI -> existing behavior remains safe
test("G1: no MMSI and no position is a safe no-op", () => {
  const shipment = makeShipment({ vessel_mmsi: null, status: "Booked" });
  const decision = deriveAisAutomation(shipment, null, config, NOW);
  assert.equal(decision.statusChanged, false);
  assert.equal(decision.status, "Booked");
});

test("G2: no MMSI still honors an authoritative recorded actual arrival", () => {
  const shipment = makeShipment({ vessel_mmsi: null, status: "In Transit", actual_arrival: new Date(NOW).toISOString() });
  const decision = deriveAisAutomation(shipment, null, config, NOW);
  assert.equal(decision.status, "Arrived");
  assert.equal(decision.statusChanged, true);
});

// H. Repeated evaluation with same AIS data -> no duplicate event
test("H: repeated evaluation of an already-settled status proposes no further change", () => {
  const shipment = makeShipment({ status: "Departed", actual_departure: new Date(NOW - DAY).toISOString() });
  const position = makePosition({ sog: 0, nav_status: "5" }); // moored — does not qualify as still under way
  const first = deriveAisAutomation(shipment, position, config, NOW);
  assert.equal(first.statusChanged, false);
  const second = deriveAisAutomation(shipment, position, config, NOW + MINUTE);
  assert.equal(second.statusChanged, false, "identical inputs must never repeatedly propose the same change");
});

// I. Status never automatically regresses
test("I: contradictory/adverse evidence never lowers status", () => {
  const shipment = makeShipment({ status: "In Transit", actual_departure: new Date(NOW - 5 * DAY).toISOString() });
  const adverse = makePosition({ sog: 0, nav_status: "5", position_timestamp: new Date(NOW - 72 * HOUR).toISOString() }); // stale + looks moored
  const decision = deriveAisAutomation(shipment, adverse, config, NOW);
  assert.ok(rank(decision.status as ActiveShipmentStatus) >= rank("In Transit"), "status must never drop below its current rank");
});

// J. Manual status remains respected / stale pending from before a manual jump is superseded
test("J: a manual status change past a stale pending candidate is respected", () => {
  // AIS previously had "Departed" pending; a manual override then jumped the
  // shipment straight to "In Transit". The stale pending value must not be
  // treated as still relevant to the (different) next candidate.
  const shipment = makeShipment({
    status: "In Transit",
    actual_departure: new Date(NOW - 3 * DAY).toISOString(),
    eta: new Date(NOW + 10 * HOUR).toISOString(),
    ais_pending_status: "Departed",
    ais_pending_since: new Date(NOW - 30 * MINUTE).toISOString(),
  });
  const position = makePosition({ sog: 10, nav_status: "0" });
  const decision = deriveAisAutomation(shipment, position, config, NOW);
  assert.equal(decision.status, "In Transit", "manual status is not overwritten by a stale AIS candidate");
  assert.equal(decision.pendingStatus, "Approaching Destination", "a fresh pending cycle starts from the shipment's real current status");
});

// K. Legacy statuses remain untouched/dormant
test("K: legacy status is frozen even with strong AIS evidence", () => {
  const shipment = makeShipment({ status: "Cleared Customs" });
  const position = makePosition({ sog: 15, nav_status: "0" });
  const decision = deriveAisAutomation(shipment, position, config, NOW);
  assert.equal(decision.status, "Cleared Customs");
  assert.equal(decision.statusChanged, false);
  assert.equal(decision.pendingStatus, null);
});

// L. Monitoring window respected (task 8) — not one of A-K but explicitly required.
test("L: a shipment far from its monitoring window ignores AIS entirely", () => {
  const shipment = makeShipment({ status: "Booked", planned_etd: new Date(NOW + 90 * DAY).toISOString() });
  const position = makePosition({ sog: 20, nav_status: "0" });
  const decision = deriveAisAutomation(shipment, position, config, NOW);
  assert.equal(decision.statusChanged, false);
  assert.equal(decision.pendingStatus, null);
});

// N. Destination-aware geofencing — deriveAisAutomation()'s "Arrived" and
// "Approaching Destination" evidence when a shipment has a destination_port_id.
test("N1: vessel stopped inside the destination geofence sets a pending Arrived candidate", () => {
  const shipment = makeShipment({ status: "Approaching Destination", destination_port_id: DESTINATION_PORT.id });
  const stopped = makePosition({ sog: 0, nav_status: "5", ...INSIDE_GEOFENCE });
  const decision = deriveAisAutomation(shipment, stopped, config, NOW, DESTINATION_PORT);
  assert.equal(decision.statusChanged, false, "first observation is only a pending candidate");
  assert.equal(decision.pendingStatus, "Arrived");
  assert.match(decision.reason, /inside the Test Port geofence/i);
});

test("N2: second qualifying observation 15+ minutes later promotes to Arrived", () => {
  let shipment = makeShipment({ status: "Approaching Destination", destination_port_id: DESTINATION_PORT.id });
  const stopped = makePosition({ sog: 0, nav_status: "5", ...INSIDE_GEOFENCE });

  const first = deriveAisAutomation(shipment, stopped, config, NOW, DESTINATION_PORT);
  shipment = { ...shipment, ais_pending_status: first.pendingStatus, ais_pending_since: first.pendingSince };

  const later = NOW + (AIS_CONFIRMATION_MINUTES + 1) * MINUTE;
  const second = deriveAisAutomation(
    shipment,
    { ...stopped, position_timestamp: new Date(later).toISOString() },
    config,
    later,
    DESTINATION_PORT,
  );
  assert.equal(second.status, "Arrived");
  assert.equal(second.statusChanged, true);
  assert.equal(second.source, "ais");
});

test("N3: vessel stopped outside the destination geofence remains at the current status", () => {
  const shipment = makeShipment({ status: "Approaching Destination", destination_port_id: DESTINATION_PORT.id });
  const stopped = makePosition({ sog: 0, nav_status: "5", ...OUTSIDE_GEOFENCE });
  const decision = deriveAisAutomation(shipment, stopped, config, NOW, DESTINATION_PORT);
  assert.equal(decision.status, "Approaching Destination");
  assert.equal(decision.statusChanged, false);
  assert.equal(decision.pendingStatus, null, "outside the geofence is not even a pending Arrived candidate");
  assert.match(decision.reason, /outside its 20 km geofence/i);
});

test("N4: vessel stopped at an intermediate port (far from destination) remains In Transit", () => {
  const shipment = makeShipment({
    status: "In Transit",
    eta: null,
    planned_eta: null,
    destination_port_id: DESTINATION_PORT.id,
  });
  const stoppedFarAway = makePosition({ sog: 0, nav_status: "5", ...FAR_AWAY });
  const decision = deriveAisAutomation(shipment, stoppedFarAway, config, NOW, DESTINATION_PORT);
  assert.equal(decision.status, "In Transit");
  assert.equal(decision.statusChanged, false);
});

test("N5: vessel underway inside the destination geofence does not immediately become Arrived", () => {
  const shipment = makeShipment({ status: "Approaching Destination", destination_port_id: DESTINATION_PORT.id });
  const underway = makePosition({ sog: 12, nav_status: "0", ...INSIDE_GEOFENCE });
  const decision = deriveAisAutomation(shipment, underway, config, NOW, DESTINATION_PORT);
  assert.equal(decision.statusChanged, false);
  assert.equal(decision.pendingStatus, null, "under way is never evidence of arrival, regardless of location");
});

test("N6: stale AIS inside the destination geofence does not trigger Arrived", () => {
  const shipment = makeShipment({ status: "Approaching Destination", destination_port_id: DESTINATION_PORT.id });
  const staleStopped = makePosition({
    sog: 0,
    nav_status: "5",
    ...INSIDE_GEOFENCE,
    position_timestamp: new Date(NOW - 48 * HOUR).toISOString(),
  });
  const decision = deriveAisAutomation(shipment, staleStopped, config, NOW, DESTINATION_PORT);
  assert.equal(decision.statusChanged, false);
  assert.equal(decision.pendingStatus, null);
});

test("N7: no destination_port_id preserves the original stop-anywhere-counts-as-arrival behavior", () => {
  let shipment = makeShipment({ status: "Approaching Destination", destination_port_id: null });
  // Same coordinates as the FAR_AWAY fixture — would fail a geofence check,
  // but there is no destination port to check against, so this must behave
  // exactly as it did before this feature existed.
  const stopped = makePosition({ sog: 0, nav_status: "5", ...FAR_AWAY });

  const first = deriveAisAutomation(shipment, stopped, config, NOW, null);
  assert.equal(first.pendingStatus, "Arrived");

  shipment = { ...shipment, ais_pending_status: first.pendingStatus, ais_pending_since: first.pendingSince };
  const later = NOW + (AIS_CONFIRMATION_MINUTES + 1) * MINUTE;
  const second = deriveAisAutomation(
    shipment,
    { ...stopped, position_timestamp: new Date(later).toISOString() },
    config,
    later,
    null,
  );
  assert.equal(second.status, "Arrived");
  assert.equal(second.statusChanged, true);
});

test("N8: a shipment already at the terminal Arrived status is never regressed or re-evaluated", () => {
  // Stands in for "manual override is not regressed": whether Arrived was
  // set manually or automatically, there is no next candidate for it, so
  // no amount of contradictory fresh AIS data can move or re-flag it.
  const shipment = makeShipment({ status: "Arrived", destination_port_id: DESTINATION_PORT.id });
  const underwayElsewhere = makePosition({ sog: 15, nav_status: "0", ...FAR_AWAY });
  const decision = deriveAisAutomation(shipment, underwayElsewhere, config, NOW, DESTINATION_PORT);
  assert.equal(decision.status, "Arrived");
  assert.equal(decision.statusChanged, false);
  assert.equal(decision.pendingStatus, null);
});

// M. deriveVesselCondition() — the derived, non-lifecycle operational read.
test("M1: fresh underway position reports Underway", () => {
  const shipment = makeShipment({ status: "In Transit" });
  const position = makePosition({ sog: 12, nav_status: "0" });
  const condition = deriveVesselCondition(shipment, position, NOW);
  assert.deepEqual(condition, { kind: "underway" });
  assert.equal(vesselConditionLabel(condition), "Underway");
});

test("M2: fresh stopped position while In Transit reports a likely-intermediate-stop hedge", () => {
  const shipment = makeShipment({ status: "In Transit" });
  const position = makePosition({ sog: 0, nav_status: "5" }); // moored
  const condition = deriveVesselCondition(shipment, position, NOW);
  assert.deepEqual(condition, { kind: "stopped", context: "in_transit" });
  assert.equal(vesselConditionLabel(condition), "Stopped · likely intermediate stop");
});

test("M3: fresh stopped position while Approaching Destination reports a likely-destination-stop hedge", () => {
  const shipment = makeShipment({ status: "Approaching Destination" });
  const position = makePosition({ sog: 0.2, nav_status: "1" }); // at anchor
  const condition = deriveVesselCondition(shipment, position, NOW);
  assert.deepEqual(condition, { kind: "stopped", context: "approaching_destination" });
  assert.equal(vesselConditionLabel(condition), "Stopped · likely destination stop");
});

test("M4: stale position never reports a condition, even with strong evidence", () => {
  const shipment = makeShipment({ status: "In Transit" });
  const stale = makePosition({ sog: 0, nav_status: "5", position_timestamp: new Date(NOW - 48 * HOUR).toISOString() });
  const condition = deriveVesselCondition(shipment, stale, NOW);
  assert.deepEqual(condition, { kind: "unknown" });
  assert.equal(vesselConditionLabel(condition), null, "no badge should be rendered for stale data");
});

test("M5: no position at all reports unknown, not a default guess", () => {
  const shipment = makeShipment({ status: "In Transit" });
  const condition = deriveVesselCondition(shipment, null, NOW);
  assert.deepEqual(condition, { kind: "unknown" });
  assert.equal(vesselConditionLabel(condition), null);
});

test("M6: fresh but ambiguous data (neither underway nor stopped) reports unknown rather than guessing", () => {
  const shipment = makeShipment({ status: "In Transit" });
  // SOG below the underway threshold but nav_status isn't in the stopped set
  // (e.g. "restricted maneuverability") — not enough evidence either way.
  const position = makePosition({ sog: 1, nav_status: "3" });
  const condition = deriveVesselCondition(shipment, position, NOW);
  assert.deepEqual(condition, { kind: "unknown" });
  assert.equal(vesselConditionLabel(condition), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
