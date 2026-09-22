/**
 * Deterministic fixture-based tests for the AIS decision layer. No live AIS,
 * no database — pure function in, decision object out.
 *
 * Reliability Phase 1 rules under test: lifecycle progression needs CURRENT
 * evidence (30 min, configurable); Departed needs a linked origin port and a
 * vessel under way, heading away, inside its departure area; In Transit needs
 * the vessel beyond that area; Approaching/Arrived need a linked destination
 * port (an ETA is never evidence); a stopped vessel needs a KNOWN speed; and
 * the 15-minute confirmation counts distinct AIS observations by their own
 * timestamps, never delivery time.
 *
 * Not wired into any test runner; run directly with a TS-aware runner that
 * understands the tsconfig path alias:
 *   npx tsx src/lib/aisAutomation.test.ts
 */
import assert from "node:assert/strict";

import { ACTIVE_STATUSES, type ActiveShipmentStatus, type Port, type Shipment, type VesselPosition } from "@/lib/api";
import { DEFAULT_MONITORING_CONFIG } from "@/lib/lifecycle";
import {
  AIS_CONFIRMATION_MINUTES,
  AIS_LIFECYCLE_FRESH_MINUTES,
  AIS_PENDING_MAX_AGE_MINUTES,
  DEPARTURE_AREA_MULTIPLIER,
  deriveAisAutomation,
  deriveVesselCondition,
  isAisFreshForLifecycle,
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

/** The point `km` from `port` along `bearingDeg` (great circle) — so tests state real distances and directions. */
function pointAt(port: Pick<Port, "latitude" | "longitude">, km: number, bearingDeg: number) {
  const d = km / 6371;
  const br = (bearingDeg * Math.PI) / 180;
  const lat1 = (port.latitude * Math.PI) / 180;
  const lon1 = (port.longitude * Math.PI) / 180;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br));
  const lon2 =
    lon1 +
    Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { latitude: (lat2 * 180) / Math.PI, longitude: ((((lon2 * 180) / Math.PI) + 540) % 360) - 180 };
}

const config = DEFAULT_MONITORING_CONFIG;
const iso = (ms: number) => new Date(ms).toISOString();

const DESTINATION_PORT = makePort();
// ~7.8km from DESTINATION_PORT — inside its 20km geofence.
const INSIDE_GEOFENCE = { latitude: 10.05, longitude: 10.05 };
// ~78km from DESTINATION_PORT — outside the 20km geofence, but still an
// "intermediate port" nearby-ish, not on the other side of the planet.
const OUTSIDE_GEOFENCE = { latitude: 10.5, longitude: 10.5 };
// ~780km from DESTINATION_PORT — outside even the wide Approaching
// Destination proximity multiplier (20km * 10 = 200km).
const FAR_AWAY = { latitude: 15, longitude: 15 };

// A separate origin port with a 20 km radius: departure area is 20 km .. 80 km.
const ORIGIN_PORT = makePort({ id: "origin-port", name: "Origin Port", unlocode: "ZZORG", latitude: 30, longitude: 120 });
const DEPARTURE_AREA_KM = ORIGIN_PORT.geofence_radius_km * DEPARTURE_AREA_MULTIPLIER;

/** Under way, `km` from the origin along `bearing`, with course = that bearing (i.e. heading directly away). */
function departing(km: number, bearing = 90, overrides: Partial<VesselPosition> = {}) {
  return makePosition({ ...pointAt(ORIGIN_PORT, km, bearing), sog: 8, nav_status: "0", cog: bearing, ...overrides });
}

const atTime = (ms: number, extra: Partial<VesselPosition> = {}): Partial<VesselPosition> => ({
  position_timestamp: iso(ms),
  received_at: iso(ms),
  ...extra,
});

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

// ===== A-B. Departure: origin evidence ======================================

test("A: vessel sitting at origin does not become Departed", () => {
  const shipment = makeShipment({ status: "Booked", origin_port_id: ORIGIN_PORT.id });
  const position = makePosition({ sog: 0.1, nav_status: "5" }); // moored, ~0 kn
  const decision = deriveAisAutomation(shipment, position, config, NOW, null, ORIGIN_PORT);
  assert.equal(decision.status, "Booked");
  assert.equal(decision.statusChanged, false);
  assert.equal(decision.pendingStatus, null);
});

test("B: no origin port linked -> AIS never confirms Departed, however convincing the movement", () => {
  const shipment = makeShipment({ status: "Booked", origin_port_id: null });
  const underway = makePosition({ sog: 14, nav_status: "0", cog: 90 });
  const first = deriveAisAutomation(shipment, underway, config, NOW, null, null);
  assert.equal(first.pendingStatus, null, "not even a pending candidate");
  assert.match(first.reason, /origin port not linked/i);

  const later = NOW + (AIS_CONFIRMATION_MINUTES + 5) * MINUTE;
  const second = deriveAisAutomation(shipment, { ...underway, ...atTime(later) }, config, later, null, null);
  assert.equal(second.statusChanged, false);
  assert.equal(second.status, "Booked");
});

test("B1: vessel underway INSIDE the origin geofence (berth shifting, harbour movement) is not a departure", () => {
  const shipment = makeShipment({ status: "Booked", origin_port_id: ORIGIN_PORT.id });
  for (const km of [1, 5, 19.9]) {
    const d = deriveAisAutomation(shipment, departing(km, 90, { sog: 4 }), config, NOW, null, ORIGIN_PORT);
    assert.equal(d.pendingStatus, null, `${km} km from origin`);
    assert.match(d.reason, /still inside the Origin Port geofence/i);
  }
});

test("B2: vessel just outside the origin geofence, under way and heading away -> qualifying departure evidence, confirmed after 15 min", () => {
  let shipment = makeShipment({ status: "Booked", origin_port_id: ORIGIN_PORT.id });
  const first = deriveAisAutomation(shipment, departing(25), config, NOW, null, ORIGIN_PORT);
  assert.equal(first.pendingStatus, "Departed");
  assert.equal(first.statusChanged, false, "first observation is only a candidate");

  shipment = { ...shipment, ais_pending_status: first.pendingStatus, ais_pending_since: first.pendingSince };
  const later = NOW + (AIS_CONFIRMATION_MINUTES + 1) * MINUTE;
  const second = deriveAisAutomation(shipment, departing(35, 90, atTime(later)), config, later, null, ORIGIN_PORT);
  assert.equal(second.status, "Departed");
  assert.equal(second.statusChanged, true);
  assert.equal(second.source, "ais");
  assert.equal(second.pendingStatus, null);
});

test("B3: vessel underway hundreds of km from the origin (before this voyage) is not treated as departing it", () => {
  const shipment = makeShipment({ status: "Booked", origin_port_id: ORIGIN_PORT.id });
  for (const km of [DEPARTURE_AREA_KM + 1, 150, 300, 800]) {
    const d = deriveAisAutomation(shipment, departing(km), config, NOW, null, ORIGIN_PORT);
    assert.equal(d.pendingStatus, null, `${km} km from origin`);
    assert.match(d.reason, /beyond its .* departure area/i);
  }
});

test("B4: departure-area boundaries are deterministic (radius excluded, outer edge included)", () => {
  const shipment = makeShipment({ status: "Booked", origin_port_id: ORIGIN_PORT.id });
  const at = (km: number) => deriveAisAutomation(shipment, departing(km), config, NOW, null, ORIGIN_PORT).pendingStatus;
  assert.equal(at(ORIGIN_PORT.geofence_radius_km - 0.05), null);
  assert.equal(at(ORIGIN_PORT.geofence_radius_km + 0.05), "Departed");
  assert.equal(at(DEPARTURE_AREA_KM - 0.05), "Departed");
  assert.equal(at(DEPARTURE_AREA_KM + 0.05), null);
});

test("B5: a vessel heading TOWARD the origin (arriving from a previous voyage) is not departing", () => {
  const shipment = makeShipment({ status: "Booked", origin_port_id: ORIGIN_PORT.id });
  const inbound = departing(40, 90, { cog: 270 }); // east of the port, steering west = toward it
  const d = deriveAisAutomation(shipment, inbound, config, NOW, null, ORIGIN_PORT);
  assert.equal(d.pendingStatus, null);
  assert.match(d.reason, /heading toward Origin Port/i);
  // A course within the 90° allowance either side of "directly away" still counts.
  const oblique = departing(40, 90, { cog: 90 + 60 });
  assert.equal(deriveAisAutomation(shipment, oblique, config, NOW, null, ORIGIN_PORT).pendingStatus, "Departed");
});

test("B6: missing/unavailable course over ground -> cannot confirm the vessel is heading away", () => {
  const shipment = makeShipment({ status: "Booked", origin_port_id: ORIGIN_PORT.id });
  for (const cog of [null, 360, Number.NaN]) {
    const d = deriveAisAutomation(shipment, departing(40, 90, { cog }), config, NOW, null, ORIGIN_PORT);
    assert.equal(d.pendingStatus, null, `cog=${cog}`);
  }
});

test("B7: under-way threshold still applies at the origin (SOG < 2 kn, or moored nav status, is not under way)", () => {
  const shipment = makeShipment({ status: "Booked", origin_port_id: ORIGIN_PORT.id });
  assert.equal(deriveAisAutomation(shipment, departing(40, 90, { sog: 1.5 }), config, NOW, null, ORIGIN_PORT).pendingStatus, null);
  assert.equal(deriveAisAutomation(shipment, departing(40, 90, { sog: 8, nav_status: "5" }), config, NOW, null, ORIGIN_PORT).pendingStatus, null);
  assert.equal(deriveAisAutomation(shipment, departing(40, 90, { sog: null }), config, NOW, null, ORIGIN_PORT).pendingStatus, null);
});

// ===== C. In Transit ========================================================

test("C: no origin port -> a Departed vessel still under way becomes In Transit once confirmed (Departed was already established another way)", () => {
  let shipment = makeShipment({ status: "Departed", actual_departure: iso(NOW - DAY) });
  const underway = makePosition({ sog: 12, nav_status: "0" });

  const first = deriveAisAutomation(shipment, underway, config, NOW);
  assert.equal(first.pendingStatus, "In Transit");
  assert.equal(first.statusChanged, false);

  shipment = { ...shipment, ais_pending_status: first.pendingStatus, ais_pending_since: first.pendingSince };
  const later = NOW + (AIS_CONFIRMATION_MINUTES + 1) * MINUTE;
  const second = deriveAisAutomation(shipment, { ...underway, ...atTime(later) }, config, later);
  assert.equal(second.status, "In Transit");
  assert.equal(second.statusChanged, true);
  assert.equal(second.source, "ais");
});

test("C1: with an origin port, a vessel still near the origin (within the departure area) is not In Transit", () => {
  const shipment = makeShipment({ status: "Departed", origin_port_id: ORIGIN_PORT.id, actual_departure: iso(NOW - DAY) });
  for (const km of [3, 25, DEPARTURE_AREA_KM - 0.05]) {
    const d = deriveAisAutomation(shipment, departing(km), config, NOW, null, ORIGIN_PORT);
    assert.equal(d.pendingStatus, null, `${km} km from origin`);
    assert.match(d.reason, /within its .* departure area/i);
  }
});

test("C2: with an origin port, a vessel that has meaningfully left the origin area becomes In Transit once confirmed", () => {
  let shipment = makeShipment({ status: "Departed", origin_port_id: ORIGIN_PORT.id, actual_departure: iso(NOW - DAY) });
  const first = deriveAisAutomation(shipment, departing(DEPARTURE_AREA_KM + 0.05), config, NOW, null, ORIGIN_PORT);
  assert.equal(first.pendingStatus, "In Transit");

  shipment = { ...shipment, ais_pending_status: first.pendingStatus, ais_pending_since: first.pendingSince };
  const later = NOW + (AIS_CONFIRMATION_MINUTES + 1) * MINUTE;
  const second = deriveAisAutomation(shipment, departing(200, 90, atTime(later)), config, later, null, ORIGIN_PORT);
  assert.equal(second.status, "In Transit");
  assert.equal(second.statusChanged, true);
});

test("C3: far from the origin but no longer under way -> not In Transit", () => {
  const shipment = makeShipment({ status: "Departed", origin_port_id: ORIGIN_PORT.id, actual_departure: iso(NOW - DAY) });
  const drifting = departing(300, 90, { sog: 0.4, nav_status: "0" });
  assert.equal(deriveAisAutomation(shipment, drifting, config, NOW, null, ORIGIN_PORT).pendingStatus, null);
});

// ===== D. Approaching Destination ==========================================

test("D: with a destination port, a fresh vessel within its approach range becomes Approaching Destination once confirmed — no ETA needed", () => {
  let shipment = makeShipment({
    status: "In Transit",
    destination_port_id: DESTINATION_PORT.id,
    eta: iso(NOW + 10 * DAY), // far-off ETA: geography alone is sufficient
  });
  const position = makePosition({ ...pointAt(DESTINATION_PORT, 100, 180), sog: 14, nav_status: "0" });

  const first = deriveAisAutomation(shipment, position, config, NOW, DESTINATION_PORT);
  assert.equal(first.pendingStatus, "Approaching Destination");
  assert.match(first.reason, /Within range of Test Port/);

  shipment = { ...shipment, ais_pending_status: first.pendingStatus, ais_pending_since: first.pendingSince };
  const later = NOW + (AIS_CONFIRMATION_MINUTES + 1) * MINUTE;
  const second = deriveAisAutomation(shipment, { ...position, ...atTime(later) }, config, later, DESTINATION_PORT);
  assert.equal(second.status, "Approaching Destination");
  assert.equal(second.statusChanged, true);
});

test("D1: an ETA inside 48 h is NOT enough when the vessel is nowhere near the destination", () => {
  const shipment = makeShipment({
    status: "In Transit",
    destination_port_id: DESTINATION_PORT.id,
    eta: iso(NOW + 10 * HOUR),
  });
  const farUnderway = makePosition({ ...FAR_AWAY, sog: 14, nav_status: "0" }); // ~780 km out, range is 200 km
  const d = deriveAisAutomation(shipment, farUnderway, config, NOW, DESTINATION_PORT);
  assert.equal(d.pendingStatus, null);
  assert.equal(d.statusChanged, false);
  assert.match(d.reason, /not yet within range/i);
});

test("D2: no destination port -> AIS cannot confirm Approaching Destination, even with an ETA in the window", () => {
  const shipment = makeShipment({ status: "In Transit", destination_port_id: null, eta: iso(NOW + 10 * HOUR) });
  const position = makePosition({ sog: 14, nav_status: "0" });
  const d = deriveAisAutomation(shipment, position, config, NOW, null);
  assert.equal(d.pendingStatus, null);
  assert.equal(d.status, "In Transit");
  assert.match(d.reason, /destination port not linked/i);
});

test("D3: stale-for-lifecycle AIS cannot produce Approaching Destination even inside the range", () => {
  const shipment = makeShipment({ status: "In Transit", destination_port_id: DESTINATION_PORT.id });
  const stale = makePosition({
    ...pointAt(DESTINATION_PORT, 50, 180),
    sog: 14,
    nav_status: "0",
    ...atTime(NOW - (AIS_LIFECYCLE_FRESH_MINUTES + 15) * MINUTE),
  });
  const d = deriveAisAutomation(shipment, stale, config, NOW, DESTINATION_PORT);
  assert.equal(d.pendingStatus, null);
  assert.match(d.reason, /no fresh AIS/i);
});

// ===== E. Arrived ===========================================================

test("E: with a destination port, a vessel anchored inside the geofence becomes Arrived once confirmed", () => {
  let shipment = makeShipment({ status: "Approaching Destination", destination_port_id: DESTINATION_PORT.id });
  const stopped = makePosition({ sog: 0.1, nav_status: "1", ...INSIDE_GEOFENCE }); // at anchor

  const first = deriveAisAutomation(shipment, stopped, config, NOW, DESTINATION_PORT);
  assert.equal(first.pendingStatus, "Arrived");

  shipment = { ...shipment, ais_pending_status: first.pendingStatus, ais_pending_since: first.pendingSince };
  const later = NOW + (AIS_CONFIRMATION_MINUTES + 1) * MINUTE;
  const second = deriveAisAutomation(shipment, { ...stopped, ...atTime(later) }, config, later, DESTINATION_PORT);
  assert.equal(second.status, "Arrived");
  assert.equal(second.statusChanged, true);
  assert.equal(second.source, "ais");
});

// ===== F. Freshness =========================================================

test("F1: no AIS position at all does not advance status", () => {
  const shipment = makeShipment({ status: "Booked", origin_port_id: ORIGIN_PORT.id });
  const decision = deriveAisAutomation(shipment, null, config, NOW, null, ORIGIN_PORT);
  assert.equal(decision.statusChanged, false);
  assert.equal(decision.pendingStatus, null);
});

test("F2: a 48 h-old position does not advance status even with strong evidence", () => {
  const shipment = makeShipment({ status: "Booked", origin_port_id: ORIGIN_PORT.id });
  const stalePosition = departing(30, 90, atTime(NOW - 48 * HOUR));
  const decision = deriveAisAutomation(shipment, stalePosition, config, NOW, null, ORIGIN_PORT);
  assert.equal(decision.statusChanged, false);
  assert.equal(decision.pendingStatus, null);
});

test("F3: a pending candidate is dropped if AIS goes stale before confirmation", () => {
  const shipment = makeShipment({
    status: "Booked",
    origin_port_id: ORIGIN_PORT.id,
    ais_pending_status: "Departed",
    ais_pending_since: iso(NOW - 20 * MINUTE), // already past the confirmation window
  });
  const stalePosition = departing(30, 90, atTime(NOW - 48 * HOUR));
  const decision = deriveAisAutomation(shipment, stalePosition, config, NOW, null, ORIGIN_PORT);
  assert.equal(decision.statusChanged, false, "stale evidence must not confirm a pending candidate, even one that's overdue");
  assert.equal(decision.pendingStatus, null);
});

test("F4: a position older than the 30-minute lifecycle window (but well inside the old 24 h) is not evidence", () => {
  const ageMin = AIS_LIFECYCLE_FRESH_MINUTES + 15;
  const shipment = makeShipment({ status: "Booked", origin_port_id: ORIGIN_PORT.id });
  const old = departing(30, 90, atTime(NOW - ageMin * MINUTE));
  const d = deriveAisAutomation(shipment, old, config, NOW, null, ORIGIN_PORT);
  assert.equal(d.pendingStatus, null);
  assert.match(d.reason, /no fresh AIS/i);

  // ...and it cannot confirm a candidate that is otherwise due.
  const due = { ...shipment, ais_pending_status: "Departed" as const, ais_pending_since: iso(NOW - 70 * MINUTE) };
  const confirm = deriveAisAutomation(due, old, config, NOW, null, ORIGIN_PORT);
  assert.equal(confirm.statusChanged, false);
  assert.equal(confirm.pendingStatus, null);
});

test("F5: stale-for-lifecycle AIS cannot produce Arrived even when stopped inside the geofence", () => {
  const shipment = makeShipment({ status: "Approaching Destination", destination_port_id: DESTINATION_PORT.id });
  const stale = makePosition({ sog: 0, nav_status: "5", ...INSIDE_GEOFENCE, ...atTime(NOW - 45 * MINUTE) });
  const d = deriveAisAutomation(shipment, stale, config, NOW, DESTINATION_PORT);
  assert.equal(d.pendingStatus, null);
  assert.equal(d.statusChanged, false);
});

test("F6: the freshness window is configurable, and read from config rather than hard-coded", () => {
  const p = departing(30, 90, atTime(NOW - 45 * MINUTE));
  assert.equal(isAisFreshForLifecycle(p, NOW), false, "default 30 min rejects 45 min");
  assert.equal(isAisFreshForLifecycle(p, NOW, { ais_lifecycle_fresh_minutes: 60 }), true);
  assert.equal(isAisFreshForLifecycle(p, NOW, { ais_lifecycle_fresh_minutes: 10 }), false);
  assert.equal(isAisFreshForLifecycle(p, NOW, { ais_lifecycle_fresh_minutes: Number.NaN }), false, "invalid setting falls back to the default");

  const shipment = makeShipment({ status: "Booked", origin_port_id: ORIGIN_PORT.id });
  const wide = { ...config, ais_lifecycle_fresh_minutes: 60 };
  assert.equal(deriveAisAutomation(shipment, p, wide, NOW, null, ORIGIN_PORT).pendingStatus, "Departed");
});

test("F7: a future-dated position (clock error) is not fresh; a few minutes of skew is tolerated", () => {
  const base = departing(30);
  assert.equal(isAisFreshForLifecycle({ ...base, ...atTime(NOW + 60 * MINUTE) }, NOW), false);
  assert.equal(isAisFreshForLifecycle({ ...base, ...atTime(NOW + 2 * MINUTE) }, NOW), true);
  assert.equal(isAisFreshForLifecycle({ ...base, ...atTime(NOW - 29 * MINUTE) }, NOW), true);
  assert.equal(isAisFreshForLifecycle({ ...base, ...atTime(NOW - 31 * MINUTE) }, NOW), false);
});

// ===== G. No MMSI ===========================================================

test("G1: no MMSI and no position is a safe no-op", () => {
  const shipment = makeShipment({ vessel_mmsi: null, status: "Booked" });
  const decision = deriveAisAutomation(shipment, null, config, NOW);
  assert.equal(decision.statusChanged, false);
  assert.equal(decision.status, "Booked");
});

test("G2: no MMSI still honors an authoritative recorded actual arrival", () => {
  const shipment = makeShipment({ vessel_mmsi: null, status: "In Transit", actual_arrival: iso(NOW) });
  const decision = deriveAisAutomation(shipment, null, config, NOW);
  assert.equal(decision.status, "Arrived");
  assert.equal(decision.statusChanged, true);
});

// ===== H-L. Existing safeguards ============================================

test("H: repeated evaluation of an already-settled status proposes no further change", () => {
  const shipment = makeShipment({ status: "Departed", actual_departure: iso(NOW - DAY) });
  const position = makePosition({ sog: 0, nav_status: "5" }); // moored — does not qualify as still under way
  const first = deriveAisAutomation(shipment, position, config, NOW);
  assert.equal(first.statusChanged, false);
  const second = deriveAisAutomation(shipment, position, config, NOW + MINUTE);
  assert.equal(second.statusChanged, false, "identical inputs must never repeatedly propose the same change");
});

test("I: contradictory/adverse evidence never lowers status", () => {
  const shipment = makeShipment({ status: "In Transit", actual_departure: iso(NOW - 5 * DAY) });
  const adverse = makePosition({ sog: 0, nav_status: "5", ...atTime(NOW - 72 * HOUR) }); // stale + looks moored
  const decision = deriveAisAutomation(shipment, adverse, config, NOW);
  assert.ok(rank(decision.status as ActiveShipmentStatus) >= rank("In Transit"), "status must never drop below its current rank");
});

test("J: a manual status change past a stale pending candidate is respected", () => {
  // AIS previously had "Departed" pending; a manual override then jumped the
  // shipment straight to "In Transit". The stale pending value must not be
  // treated as still relevant to the (different) next candidate.
  const shipment = makeShipment({
    status: "In Transit",
    destination_port_id: DESTINATION_PORT.id,
    actual_departure: iso(NOW - 3 * DAY),
    ais_pending_status: "Departed",
    ais_pending_since: iso(NOW - 30 * MINUTE),
  });
  const position = makePosition({ ...pointAt(DESTINATION_PORT, 100, 180), sog: 10, nav_status: "0" });
  const decision = deriveAisAutomation(shipment, position, config, NOW, DESTINATION_PORT);
  assert.equal(decision.status, "In Transit", "manual status is not overwritten by a stale AIS candidate");
  assert.equal(decision.pendingStatus, "Approaching Destination", "a fresh pending cycle starts from the shipment's real current status");
  assert.equal(decision.pendingSince, iso(NOW), "restarted from this observation's own timestamp");
});

test("K: legacy status is frozen even with strong AIS evidence", () => {
  const shipment = makeShipment({ status: "Cleared Customs" });
  const position = makePosition({ sog: 15, nav_status: "0" });
  const decision = deriveAisAutomation(shipment, position, config, NOW);
  assert.equal(decision.status, "Cleared Customs");
  assert.equal(decision.statusChanged, false);
  assert.equal(decision.pendingStatus, null);
});

// ===== L. Monitoring window ================================================

test("L: a shipment far from its monitoring window ignores AIS entirely", () => {
  const shipment = makeShipment({
    status: "Booked",
    origin_port_id: ORIGIN_PORT.id,
    planned_etd: iso(NOW + 90 * DAY),
    monitoring_state: "Scheduled",
  });
  const decision = deriveAisAutomation(shipment, departing(30), config, NOW, null, ORIGIN_PORT);
  assert.equal(decision.statusChanged, false);
  assert.equal(decision.pendingStatus, null);
});

test("L1: ETD 30 days away -> a perfect departure signal from the vessel does nothing", () => {
  const shipment = makeShipment({
    status: "Booked",
    origin_port_id: ORIGIN_PORT.id,
    planned_etd: iso(NOW + 30 * DAY),
    monitoring_state: "Scheduled",
  });
  const decision = deriveAisAutomation(shipment, departing(30), config, NOW, null, ORIGIN_PORT);
  assert.equal(decision.pendingStatus, null);
  assert.equal(decision.monitoring_state, "Scheduled");
  assert.equal(decision.statusChanged, false);
});

test("L2: ETD exactly 48 h away -> monitoring is eligible and AIS can propose a departure candidate", () => {
  const shipment = makeShipment({
    status: "Booked",
    origin_port_id: ORIGIN_PORT.id,
    planned_etd: iso(NOW + 48 * HOUR),
    monitoring_state: "Scheduled",
  });
  const decision = deriveAisAutomation(shipment, departing(30), config, NOW, null, ORIGIN_PORT);
  assert.equal(decision.monitoring_state, "Active Monitoring");
  assert.equal(decision.monitoringChanged, true);
  assert.equal(decision.pendingStatus, "Departed");
});

test("L3: ETD 49 h away -> still outside the window", () => {
  const shipment = makeShipment({
    status: "Booked",
    origin_port_id: ORIGIN_PORT.id,
    planned_etd: iso(NOW + 49 * HOUR),
    monitoring_state: "Scheduled",
  });
  const decision = deriveAisAutomation(shipment, departing(30), config, NOW, null, ORIGIN_PORT);
  assert.notEqual(decision.monitoring_state, "Active Monitoring");
  assert.equal(decision.pendingStatus, null);
});

test("L4: no planned ETD (and no recorded departure) -> no window is invented, AIS stays dormant even if a stale stored state says Active", () => {
  const shipment = makeShipment({ status: "Booked", origin_port_id: ORIGIN_PORT.id, planned_etd: null, monitoring_state: "Active Monitoring" });
  const decision = deriveAisAutomation(shipment, departing(30), config, NOW, null, ORIGIN_PORT);
  assert.equal(decision.pendingStatus, null);
  assert.equal(decision.statusChanged, false);
  assert.equal(decision.monitoring_state, "Scheduled");
});

// ===== N. Destination geofence ============================================

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
  const second = deriveAisAutomation(shipment, { ...stopped, ...atTime(later) }, config, later, DESTINATION_PORT);
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

test("N5: vessel underway inside the destination geofence does not become Arrived", () => {
  const shipment = makeShipment({ status: "Approaching Destination", destination_port_id: DESTINATION_PORT.id });
  const underway = makePosition({ sog: 12, nav_status: "0", ...INSIDE_GEOFENCE });
  const decision = deriveAisAutomation(shipment, underway, config, NOW, DESTINATION_PORT);
  assert.equal(decision.statusChanged, false);
  assert.equal(decision.pendingStatus, null, "under way is never evidence of arrival, regardless of location");
});

test("N6: stale AIS inside the destination geofence does not trigger Arrived", () => {
  const shipment = makeShipment({ status: "Approaching Destination", destination_port_id: DESTINATION_PORT.id });
  const staleStopped = makePosition({ sog: 0, nav_status: "5", ...INSIDE_GEOFENCE, ...atTime(NOW - 48 * HOUR) });
  const decision = deriveAisAutomation(shipment, staleStopped, config, NOW, DESTINATION_PORT);
  assert.equal(decision.statusChanged, false);
  assert.equal(decision.pendingStatus, null);
});

test("N7: NO destination port -> AIS never sets Arrived, not even for a confirmed stop repeated 20 minutes apart", () => {
  let shipment = makeShipment({ status: "Approaching Destination", destination_port_id: null });
  // A moored vessel — but with no destination coordinate this could be an
  // intermediate port, an anchorage, a weather stop, bunkering...
  const stopped = makePosition({ sog: 0, nav_status: "5", ...FAR_AWAY });

  const first = deriveAisAutomation(shipment, stopped, config, NOW, null);
  assert.equal(first.pendingStatus, null, "not even a pending Arrived candidate");
  assert.match(first.reason, /destination port not linked/i);

  shipment = { ...shipment, ais_pending_status: first.pendingStatus, ais_pending_since: first.pendingSince };
  const later = NOW + 20 * MINUTE;
  const second = deriveAisAutomation(shipment, { ...stopped, ...atTime(later) }, config, later, null);
  assert.equal(second.statusChanged, false);
  assert.equal(second.status, "Approaching Destination");
});

test("N8: a shipment already at the terminal Arrived status is never regressed or re-evaluated", () => {
  const shipment = makeShipment({ status: "Arrived", destination_port_id: DESTINATION_PORT.id });
  const underwayElsewhere = makePosition({ sog: 15, nav_status: "0", ...FAR_AWAY });
  const decision = deriveAisAutomation(shipment, underwayElsewhere, config, NOW, DESTINATION_PORT);
  assert.equal(decision.status, "Arrived");
  assert.equal(decision.statusChanged, false);
  assert.equal(decision.pendingStatus, null);
});

test("N9: unknown speed is not 'stopped' — null SOG with an anchored/moored nav status is insufficient evidence", () => {
  const shipment = makeShipment({ status: "Approaching Destination", destination_port_id: DESTINATION_PORT.id });
  for (const nav of ["1", "5"]) {
    const d = deriveAisAutomation(shipment, makePosition({ sog: null, nav_status: nav, ...INSIDE_GEOFENCE }), config, NOW, DESTINATION_PORT);
    assert.equal(d.pendingStatus, null, `nav ${nav}`);
    assert.match(d.reason, /speed unavailable/i);
  }
});

test("N10: stopped means SOG <= 0.5 kn AND anchored/moored — 0.5 qualifies, 0.6 is underway", () => {
  const shipment = makeShipment({ status: "Approaching Destination", destination_port_id: DESTINATION_PORT.id });
  const at = (sog: number, nav = "5") =>
    deriveAisAutomation(shipment, makePosition({ sog, nav_status: nav, ...INSIDE_GEOFENCE }), config, NOW, DESTINATION_PORT).pendingStatus;
  assert.equal(at(0.5), "Arrived");
  assert.equal(at(0.6), null);
  assert.equal(at(0, "0"), null, "no stopped nav status");
  assert.equal(at(0, "15"), null, "nav status 'not defined' is not stopped");
});

test("N11: the 'speed not available' sentinel (102.3 kn) is never a speed — neither under way nor stopped", () => {
  const arrival = makeShipment({ status: "Approaching Destination", destination_port_id: DESTINATION_PORT.id });
  assert.equal(
    deriveAisAutomation(arrival, makePosition({ sog: 102.3, nav_status: "5", ...INSIDE_GEOFENCE }), config, NOW, DESTINATION_PORT).pendingStatus,
    null,
  );
  const departure = makeShipment({ status: "Booked", origin_port_id: ORIGIN_PORT.id });
  assert.equal(deriveAisAutomation(departure, departing(30, 90, { sog: 102.3 }), config, NOW, null, ORIGIN_PORT).pendingStatus, null);
});

// ===== P. Debounce: distinct observations ================================

test("P1: the SAME position replayed 20 minutes later is not a second observation", () => {
  const first = makeShipment({ status: "Booked", origin_port_id: ORIGIN_PORT.id });
  const position = departing(30); // position_timestamp = NOW
  const one = deriveAisAutomation(first, position, config, NOW, null, ORIGIN_PORT);
  assert.equal(one.pendingStatus, "Departed");

  const pending = { ...first, ais_pending_status: one.pendingStatus, ais_pending_since: one.pendingSince };
  const later = NOW + 20 * MINUTE;
  // Same report (same position_timestamp), delivered again 20 min later — even
  // stamped as freshly received. Still within the 30 min freshness window.
  const replay = deriveAisAutomation(pending, { ...position, received_at: iso(later) }, config, later, null, ORIGIN_PORT);
  assert.equal(replay.statusChanged, false, "a replay cannot corroborate itself");
  assert.equal(replay.pendingStatus, "Departed");
  assert.equal(replay.pendingSince, one.pendingSince, "the debounce window is neither advanced nor reset");
});

test("P2: two genuinely distinct observations exactly 15 minutes apart can confirm (boundary included)", () => {
  const ship = makeShipment({ status: "Booked", origin_port_id: ORIGIN_PORT.id });
  const one = deriveAisAutomation(ship, departing(30), config, NOW, null, ORIGIN_PORT);
  const pending = { ...ship, ais_pending_status: one.pendingStatus, ais_pending_since: one.pendingSince };

  const t = NOW + AIS_CONFIRMATION_MINUTES * MINUTE;
  const two = deriveAisAutomation(pending, departing(38, 90, atTime(t)), config, t, null, ORIGIN_PORT);
  assert.equal(two.status, "Departed");
  assert.equal(two.statusChanged, true);

  const early = NOW + (AIS_CONFIRMATION_MINUTES * MINUTE - 1000);
  const tooSoon = deriveAisAutomation(pending, departing(38, 90, atTime(early)), config, early, null, ORIGIN_PORT);
  assert.equal(tooSoon.statusChanged, false, "14m59s is not enough");
});

test("P3: a pending candidate whose first observation is > 120 min old expires and restarts instead of confirming", () => {
  const ship = makeShipment({
    status: "Booked",
    origin_port_id: ORIGIN_PORT.id,
    ais_pending_status: "Departed",
    ais_pending_since: iso(NOW - (AIS_PENDING_MAX_AGE_MINUTES + 10) * MINUTE),
  });
  const d = deriveAisAutomation(ship, departing(30), config, NOW, null, ORIGIN_PORT);
  assert.equal(d.statusChanged, false);
  assert.equal(d.pendingStatus, "Departed");
  assert.equal(d.pendingSince, iso(NOW), "restarted from the current observation");

  // Just inside the limit still confirms.
  const inside = { ...ship, ais_pending_since: iso(NOW - (AIS_PENDING_MAX_AGE_MINUTES - 5) * MINUTE) };
  assert.equal(deriveAisAutomation(inside, departing(30), config, NOW, null, ORIGIN_PORT).status, "Departed");
});

test("P4: a contradictory observation clears the pending candidate", () => {
  const ship = makeShipment({
    status: "Booked",
    origin_port_id: ORIGIN_PORT.id,
    ais_pending_status: "Departed",
    ais_pending_since: iso(NOW - 10 * MINUTE),
  });
  // The vessel is back inside the port geofence, moored.
  const back = makePosition({ ...pointAt(ORIGIN_PORT, 2, 90), sog: 0, nav_status: "5" });
  const d = deriveAisAutomation(ship, back, config, NOW, null, ORIGIN_PORT);
  assert.equal(d.pendingStatus, null);
  assert.equal(d.pendingSince, null);
  assert.equal(d.statusChanged, false);
});

test("P5: an observation OLDER than the one that started the candidate is not corroboration", () => {
  const ship = makeShipment({
    status: "Booked",
    origin_port_id: ORIGIN_PORT.id,
    ais_pending_status: "Departed",
    ais_pending_since: iso(NOW),
  });
  const older = departing(30, 90, atTime(NOW - 10 * MINUTE));
  const d = deriveAisAutomation(ship, older, config, NOW, null, ORIGIN_PORT);
  assert.equal(d.statusChanged, false);
  assert.equal(d.pendingStatus, "Departed");
  assert.equal(d.pendingSince, iso(NOW), "unchanged");
});

test("P6: confirmation is measured in position time — delivery/evaluation time alone never advances a candidate", () => {
  const ship = makeShipment({ status: "Booked", origin_port_id: ORIGIN_PORT.id });
  const p = departing(30);
  const one = deriveAisAutomation(ship, p, config, NOW, null, ORIGIN_PORT);
  const pending = { ...ship, ais_pending_status: one.pendingStatus, ais_pending_since: one.pendingSince };
  // Evaluating repeatedly, ever later, against the same report: no promotion at any point.
  for (const minutes of [1, 5, 15, 16, 25]) {
    const t = NOW + minutes * MINUTE;
    const d = deriveAisAutomation(pending, { ...p, received_at: iso(t) }, config, t, null, ORIGIN_PORT);
    assert.equal(d.statusChanged, false, `+${minutes} min`);
  }
});

// ===== M. deriveVesselCondition() — the derived, non-lifecycle read =======

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
  const stale = makePosition({ sog: 0, nav_status: "5", ...atTime(NOW - 48 * HOUR) });
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

test("M7: a stopped nav status with an UNKNOWN speed is 'unknown', not 'stopped'", () => {
  const shipment = makeShipment({ status: "In Transit" });
  const position = makePosition({ sog: null, nav_status: "5" });
  assert.deepEqual(deriveVesselCondition(shipment, position, NOW), { kind: "unknown" });
});

// ===== Q. Phase 2: milestone stamps, transition identity, operator hold =====

test("Q1: a confirmed Booked -> Departed stamps actual_departure with the FIRST qualifying observation's AIS time (not the confirmation time, not now)", () => {
  let shipment = makeShipment({ status: "Booked", origin_port_id: ORIGIN_PORT.id });
  const first = deriveAisAutomation(shipment, departing(25), config, NOW, null, ORIGIN_PORT);
  shipment = { ...shipment, ais_pending_status: first.pendingStatus, ais_pending_since: first.pendingSince };
  const later = NOW + (AIS_CONFIRMATION_MINUTES + 3) * MINUTE;
  const second = deriveAisAutomation(shipment, departing(35, 90, atTime(later)), config, later + 5 * MINUTE, null, ORIGIN_PORT);
  assert.equal(second.statusChanged, true);
  assert.equal(second.stampActualDeparture, iso(NOW));
  assert.equal(second.evidenceAt, iso(NOW), "the transition's identity is the first observation");
  assert.equal(second.stampActualArrival, null);
});

test("Q2: a confirmed Approaching -> Arrived stamps actual_arrival from the AIS observation time and never actual_departure", () => {
  let shipment = makeShipment({ status: "Approaching Destination", destination_port_id: DESTINATION_PORT.id });
  const stopped = makePosition({ sog: 0, nav_status: "5", ...INSIDE_GEOFENCE });
  const first = deriveAisAutomation(shipment, stopped, config, NOW, DESTINATION_PORT);
  shipment = { ...shipment, ais_pending_status: first.pendingStatus, ais_pending_since: first.pendingSince };
  const later = NOW + (AIS_CONFIRMATION_MINUTES + 1) * MINUTE;
  const second = deriveAisAutomation(shipment, { ...stopped, ...atTime(later) }, config, later, DESTINATION_PORT);
  assert.equal(second.status, "Arrived");
  assert.equal(second.stampActualArrival, iso(NOW));
  assert.equal(second.stampActualDeparture, null);
});

test("Q3: Departed -> In Transit and In Transit -> Approaching stamp nothing", () => {
  let shipment = makeShipment({ status: "Departed", origin_port_id: ORIGIN_PORT.id });
  const first = deriveAisAutomation(shipment, departing(150), config, NOW, null, ORIGIN_PORT);
  shipment = { ...shipment, ais_pending_status: first.pendingStatus, ais_pending_since: first.pendingSince };
  const later = NOW + (AIS_CONFIRMATION_MINUTES + 1) * MINUTE;
  const second = deriveAisAutomation(shipment, departing(160, 90, atTime(later)), config, later, null, ORIGIN_PORT);
  assert.equal(second.status, "In Transit");
  assert.equal(second.stampActualDeparture, null);
  assert.equal(second.stampActualArrival, null);

  let transit = makeShipment({ status: "In Transit", destination_port_id: DESTINATION_PORT.id });
  const near = makePosition({ sog: 10, nav_status: "0", ...pointAt(DESTINATION_PORT, 100, 0) });
  const a = deriveAisAutomation(transit, near, config, NOW, DESTINATION_PORT);
  transit = { ...transit, ais_pending_status: a.pendingStatus, ais_pending_since: a.pendingSince };
  const b = deriveAisAutomation(transit, { ...near, ...atTime(later) }, config, later, DESTINATION_PORT);
  assert.equal(b.status, "Approaching Destination");
  assert.equal(b.stampActualDeparture, null);
  assert.equal(b.stampActualArrival, null);
});

test("Q4: an unconfirmed candidate (first observation only) proposes no change and stamps nothing", () => {
  const shipment = makeShipment({ status: "Booked", origin_port_id: ORIGIN_PORT.id });
  const first = deriveAisAutomation(shipment, departing(25), config, NOW, null, ORIGIN_PORT);
  assert.equal(first.statusChanged, false);
  assert.equal(first.stampActualDeparture, null);
  assert.equal(first.stampActualArrival, null);
  assert.equal(first.evidenceAt, null);
});

test("Q5: a recorded actual arrival (an operator fact, source 'system') is not re-stamped — the recorded value stands", () => {
  const shipment = makeShipment({ status: "In Transit", actual_arrival: iso(NOW - HOUR) });
  const decision = deriveAisAutomation(shipment, null, config, NOW);
  assert.equal(decision.status, "Arrived");
  assert.equal(decision.source, "system");
  assert.equal(decision.stampActualArrival, null);
  assert.equal(decision.evidenceAt, shipment.actual_arrival);
});

test("Q6: while an operator hold is in force AIS stands down — no advance, no pending candidate accumulates, and the reason says why", () => {
  const holdUntil = iso(NOW + 6 * HOUR);
  const base = makeShipment({ status: "Booked", origin_port_id: ORIGIN_PORT.id, automation_hold_until: holdUntil });
  const held = deriveAisAutomation(base, departing(25), config, NOW, null, ORIGIN_PORT);
  assert.equal(held.statusChanged, false);
  assert.equal(held.pendingStatus, null, "evidence observed during the hold must not be banked");
  assert.equal(held.pendingSince, null);
  assert.match(held.reason, /Automation paused after a manual status correction until 2026-09-16 18:00 UTC/);

  // A pending candidate that pre-dates the hold cannot confirm during it either.
  const stale = { ...base, ais_pending_status: "Departed" as const, ais_pending_since: iso(NOW - 40 * MINUTE) };
  const still = deriveAisAutomation(stale, departing(35, 90, atTime(NOW)), config, NOW, null, ORIGIN_PORT);
  assert.equal(still.statusChanged, false);
  assert.equal(still.stampActualDeparture, null);
});

test("Q7: the instant the hold expires, evidence gathered DURING it does not count — confirmation needs fresh observations after it", () => {
  const holdUntil = NOW + 30 * MINUTE;
  const shipment = makeShipment({ status: "Booked", origin_port_id: ORIGIN_PORT.id, automation_hold_until: iso(holdUntil) });
  const during = deriveAisAutomation(shipment, departing(25), config, NOW, null, ORIGIN_PORT);
  assert.equal(during.pendingStatus, null);
  const afterHold = holdUntil + MINUTE;
  const first = deriveAisAutomation(shipment, departing(30, 90, atTime(afterHold)), config, afterHold, null, ORIGIN_PORT);
  assert.equal(first.pendingStatus, "Departed", "a new candidate starts");
  assert.equal(first.statusChanged, false, "and is not immediately confirmed");
  assert.equal(first.pendingSince, iso(afterHold));
});

test("Q8: the monitoring-state explanation travels separately from the AIS evidence text", () => {
  const shipment = makeShipment({ status: "Booked", monitoring_state: "Scheduled", origin_port_id: ORIGIN_PORT.id });
  const decision = deriveAisAutomation(shipment, departing(25), config, NOW, null, ORIGIN_PORT);
  assert.equal(decision.monitoringChanged, true);
  assert.notEqual(decision.monitoringReason, decision.reason);
  assert.doesNotMatch(decision.monitoringReason, /AIS|geofence|underway/i);
});

test("Q9: the end of a hold (expired or lifted) is an evidence boundary — an observation at or before it starts nothing; one after it does", () => {
  const holdEnd = NOW - 10 * MINUTE;
  const shipment = makeShipment({ status: "Booked", origin_port_id: ORIGIN_PORT.id, automation_hold_until: iso(holdEnd) });

  const before = deriveAisAutomation(shipment, departing(25, 90, atTime(NOW - 20 * MINUTE)), config, NOW, null, ORIGIN_PORT);
  assert.equal(before.pendingStatus, null);
  assert.equal(before.statusChanged, false);
  assert.match(before.reason, /Waiting for an AIS observation after 2026-09-16 11:50 UTC/);

  const atBoundary = deriveAisAutomation(shipment, departing(25, 90, atTime(holdEnd)), config, NOW, null, ORIGIN_PORT);
  assert.equal(atBoundary.pendingStatus, null, "exactly at the boundary is still not after it");

  const after = deriveAisAutomation(shipment, departing(25, 90, atTime(holdEnd + MINUTE)), config, NOW, null, ORIGIN_PORT);
  assert.equal(after.pendingStatus, "Departed");
  assert.equal(after.pendingSince, iso(holdEnd + MINUTE));
});

test("Q10: a pending candidate that pre-dates the boundary cannot confirm on a newer observation either (it is dropped)", () => {
  const holdEnd = NOW - 10 * MINUTE;
  const shipment = makeShipment({
    status: "Booked",
    origin_port_id: ORIGIN_PORT.id,
    automation_hold_until: iso(holdEnd),
    ais_pending_status: "Departed",
    ais_pending_since: iso(NOW - 40 * MINUTE),
  });
  // A stale observation (pre-boundary) drops it rather than confirming.
  const stale = deriveAisAutomation(shipment, departing(30, 90, atTime(holdEnd - MINUTE)), config, NOW, null, ORIGIN_PORT);
  assert.equal(stale.statusChanged, false);
  assert.equal(stale.pendingStatus, null);
});

test("Q11: with no hold history at all, nothing changes — observations count as before", () => {
  const shipment = makeShipment({ status: "Booked", origin_port_id: ORIGIN_PORT.id, automation_hold_until: null });
  const d = deriveAisAutomation(shipment, departing(25), config, NOW, null, ORIGIN_PORT);
  assert.equal(d.pendingStatus, "Departed");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
