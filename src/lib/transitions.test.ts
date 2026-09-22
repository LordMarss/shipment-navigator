/**
 * Phase 2 plumbing tests: everything that writes a shipment's lifecycle goes
 * through ONE atomic, compare-and-set path. Runs the real application code
 * (applyAutomation / overrideStatus / advanceStatus / saveShipmentDetails /
 * evaluateAisPositionForMmsi / runAutomationSweep) against the shared
 * in-memory fake, whose emulation of the database functions is proven
 * equivalent to the real SQL in transitions.db.test.ts.
 *
 * Race tests start the competing flows together (Promise.all, and with the
 * second flow started 0..N microtask ticks later) so they genuinely
 * interleave at every await: both read the same stale snapshot before either
 * writes. The RPC body itself runs to completion without interleaving, like a
 * database function under a row lock.
 *
 *   npx tsx src/lib/transitions.test.ts
 */
import assert from "node:assert/strict";

import {
  advanceStatus,
  applyAutomation,
  overrideStatus,
  resumeAutomation,
  saveShipmentDetails,
  updateShipment,
  type AutomationDecision,
  type Db,
  type Port,
  type Shipment,
  type VesselPosition,
} from "@/lib/api";
import { applyAisDecision } from "@/lib/aisAutomation";
import { evaluateAisPositionForMmsi } from "@/lib/aisWebhook.server";
import { runAutomationSweep } from "@/lib/automation.server";
import { makeFakeDb, type FakeDb, type Row } from "@/lib/testkit/fakeDb";

const DAY = 86_400_000;
const MINUTE = 60_000;
const HOUR_MS = 3_600_000;
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

// ---------------------------------------------------------------- fixtures ---

const DEST: Port = {
  id: "dest-port",
  name: "Destination Port",
  unlocode: "ZZDST",
  country: "Testland",
  latitude: 10,
  longitude: 10,
  geofence_radius_km: 20,
  port_type: "general",
  source: "manual_seed",
  source_identifier: null,
  active: true,
  created_at: iso(NOW),
  updated_at: iso(NOW),
};
const ORIGIN: Port = {
  ...DEST,
  id: "origin-port",
  name: "Origin Port",
  unlocode: "ZZORG",
  latitude: 30,
  longitude: 120,
};

function pointAt(port: Pick<Port, "latitude" | "longitude">, km: number, bearingDeg: number) {
  const d = km / 6371;
  const br = (bearingDeg * Math.PI) / 180;
  const lat1 = (port.latitude * Math.PI) / 180;
  const lon1 = (port.longitude * Math.PI) / 180;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(br) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    );
  return { latitude: (lat2 * 180) / Math.PI, longitude: (lon2 * 180) / Math.PI };
}

function makeShipment(o: Partial<Shipment> = {}): Shipment {
  return {
    id: "s1",
    client_name: "Test Client",
    origin: "Shanghai",
    destination: "Los Angeles",
    vessel_name: "V",
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
    ...o,
  };
}

function makePosition(o: Partial<VesselPosition> = {}): VesselPosition {
  return {
    mmsi: "123456789",
    vessel_name: "V",
    latitude: 0,
    longitude: 0,
    sog: 0,
    cog: null,
    true_heading: null,
    nav_status: "5",
    position_timestamp: iso(NOW - MINUTE),
    received_at: iso(NOW - MINUTE),
    source: "aisstream",
    updated_at: iso(NOW - MINUTE),
    ...o,
  };
}

const asRows = (...xs: unknown[]) => xs as unknown as Row[];
const shipmentOf = (db: FakeDb, id = "s1") =>
  db.tables["shipments"]!.find((r) => r["id"] === id) as unknown as Shipment;
const eventsOf = (db: FakeDb, filter: (e: Row) => boolean = () => true) =>
  db.tables["shipment_events"]!.filter(filter);
const autoStatusEvents = (db: FakeDb) => eventsOf(db, (e) => e["event_type"] === "status_auto");
const decisionFor = (s: Shipment, over: Partial<AutomationDecision> = {}): AutomationDecision => ({
  status: "Departed",
  monitoring_state: "Active Monitoring",
  reason: "AIS shows the vessel departing",
  source: "ais",
  statusChanged: true,
  monitoringChanged: false,
  pending: { status: null, since: null },
  evidenceAt: s.ais_pending_since,
  ...over,
});

/** Shipment 20 min into a pending Arrived candidate; a stopped fix inside the destination geofence 1 min ago confirms it. */
function arrivalReady(over: Partial<Shipment> = {}) {
  return makeFakeDb({
    shipments: asRows(
      makeShipment({
        status: "Approaching Destination",
        destination_port_id: DEST.id,
        actual_departure: iso(NOW - 9 * DAY),
        ais_pending_status: "Arrived",
        ais_pending_since: iso(NOW - 20 * MINUTE),
        ...over,
      }),
    ),
    ports: asRows(DEST),
    vessel_positions: asRows(makePosition({ ...pointAt(DEST, 5, 0) })),
  });
}
/** Shipment with a pending Departed candidate that a fix 1 min ago (30 km out, heading away) confirms. */
function departureReady(over: Partial<Shipment> = {}) {
  return makeFakeDb({
    shipments: asRows(
      makeShipment({
        status: "Booked",
        origin_port_id: ORIGIN.id,
        ais_pending_status: "Departed",
        ais_pending_since: iso(NOW - 20 * MINUTE),
        ...over,
      }),
    ),
    ports: asRows(ORIGIN),
    vessel_positions: asRows(
      makePosition({ ...pointAt(ORIGIN, 30, 90), sog: 8, cog: 90, nav_status: "0" }),
    ),
  });
}

const ticks = async (n: number) => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

// ============================================ the wrapper: keys, no-ops ====

await test("applyAutomation: one RPC, deterministic dedupe key built from shipment/from/to/source/evidence time", async () => {
  const db = departureReady();
  const s = { ...shipmentOf(db) };
  const outcome = await applyAutomation(
    s,
    decisionFor(s, { stampActualDeparture: s.ais_pending_since }),
    db,
  );
  assert.equal(outcome.outcome, "applied");
  assert.equal(db.rpcCalls.length, 1);
  assert.equal(
    db.rpcCalls[0]!.args["p_status_dedupe_key"],
    `status:s1:Booked>Departed:ais:${s.ais_pending_since}`,
  );
  assert.equal(autoStatusEvents(db)[0]!["dedupe_key"], db.rpcCalls[0]!.args["p_status_dedupe_key"]);
  assert.equal(db.tables["alerts"]!.length, 1);
});

await test("applyAutomation: the key is a pure function — same inputs, same key; different evidence or target, different key; no evidence, no key", async () => {
  const { transitionDedupeKey: k } = await import("@/lib/api");
  const t = iso(NOW);
  assert.equal(
    k("a", "Booked", "Departed", "ais", t),
    k("a", "Booked", "Departed", "ais", new Date(t).toISOString()),
  );
  assert.notEqual(
    k("a", "Booked", "Departed", "ais", t),
    k("a", "Booked", "Departed", "ais", iso(NOW + 1000)),
  );
  assert.notEqual(
    k("a", "Booked", "Departed", "ais", t),
    k("a", "Booked", "Departed", "system", t),
  );
  assert.notEqual(
    k("a", "Booked", "Departed", "ais", t),
    k("a", "Departed", "In Transit", "ais", t),
  );
  assert.equal(k("a", "Booked", "Departed", "ais", null), null);
  assert.equal(k("a", "Booked", "Departed", "ais", "not a date"), null);
  assert.doesNotMatch(
    String(k("a", "Booked", "Departed", "ais", t)),
    /[0-9a-f]{8}-[0-9a-f]{4}-4/,
    "never a random uuid",
  );
});

await test("applyAutomation: nothing to change -> no database call", async () => {
  const db = departureReady({ ais_pending_status: null, ais_pending_since: null });
  const s = shipmentOf(db);
  const r = await applyAutomation(
    s,
    {
      status: "Booked",
      monitoring_state: "Active Monitoring",
      reason: "x",
      source: "ais",
      statusChanged: false,
      monitoringChanged: false,
      pending: { status: null, since: null },
    },
    db,
  );
  assert.equal(r.outcome, "noop");
  assert.equal(db.rpcCalls.length, 0);
  assert.equal(db.writes.length, 0);
});

// ====================================== compare-and-set / duplicate / distinct ====

await test("compare-and-set: applying the same decision twice from the same snapshot -> first applies, second is a conflict; ONE event, ONE alert", async () => {
  const db = departureReady();
  const snapshot = { ...shipmentOf(db) };
  const d = decisionFor(snapshot);
  const first = await applyAutomation(snapshot, d, db);
  const second = await applyAutomation(snapshot, d, db);
  assert.equal(first.outcome, "applied");
  assert.equal(second.outcome, "conflict");
  assert.equal(autoStatusEvents(db).length, 1);
  assert.equal(db.tables["alerts"]!.length, 1);
});

await test("duplicate transition: an already-recorded logical transition is refused even if the shipment is put back (dedupe key)", async () => {
  const db = departureReady();
  const snapshot = { ...shipmentOf(db) };
  await applyAutomation(snapshot, decisionFor(snapshot), db);
  Object.assign(shipmentOf(db), {
    status: "Booked",
    ais_pending_status: "Departed",
    ais_pending_since: snapshot.ais_pending_since,
  });
  const again = await applyAutomation(snapshot, decisionFor(snapshot), db);
  assert.equal(again.outcome, "duplicate");
  assert.equal(autoStatusEvents(db).length, 1);
});

await test("distinct transitions are all recorded: Booked>Departed, Departed>In Transit, In Transit>Approaching each write their own event", async () => {
  const db = makeFakeDb({
    shipments: asRows(
      makeShipment({ ais_pending_status: "Departed", ais_pending_since: iso(NOW - 60 * MINUTE) }),
    ),
  });
  const steps: Array<[Shipment["status"], Shipment["status"]]> = [
    ["Booked", "Departed"],
    ["Departed", "In Transit"],
    ["In Transit", "Approaching Destination"],
  ];
  let i = 0;
  for (const [from, to] of steps) {
    const at = iso(NOW - (60 - 15 * i) * MINUTE);
    Object.assign(shipmentOf(db), { ais_pending_status: to, ais_pending_since: at });
    const snap = { ...shipmentOf(db) };
    assert.equal(snap.status, from);
    assert.equal(
      (await applyAutomation(snap, decisionFor(snap, { status: to, evidenceAt: at }), db)).outcome,
      "applied",
      `${from}>${to}`,
    );
    i += 1;
  }
  assert.equal(shipmentOf(db).status, "Approaching Destination");
  assert.equal(autoStatusEvents(db).length, 3);
  assert.equal(new Set(autoStatusEvents(db).map((e) => e["dedupe_key"])).size, 3);
});

await test("a stale pending candidate is compare-and-set too: it cannot be replaced by an evaluation of an older snapshot", async () => {
  const db = departureReady();
  const stale = { ...shipmentOf(db) };
  Object.assign(shipmentOf(db), { ais_pending_since: iso(NOW - 5 * MINUTE) });
  const r = await applyAutomation(
    stale,
    {
      ...decisionFor(stale),
      statusChanged: false,
      pending: { status: "Departed", since: iso(NOW - 1000) },
    },
    db,
  );
  assert.equal(r.outcome, "conflict");
  assert.equal(shipmentOf(db).ais_pending_since, iso(NOW - 5 * MINUTE));
});

await test("an automation decision never moves a shipment backward, and never touches a legacy status", async () => {
  const db = makeFakeDb({
    shipments: asRows(
      makeShipment({ status: "In Transit" }),
      makeShipment({ id: "s2", status: "Delivered" }),
    ),
  });
  const back = shipmentOf(db);
  assert.equal(
    (await applyAutomation(back, decisionFor(back, { status: "Booked", evidenceAt: iso(NOW) }), db))
      .outcome,
    "rejected",
  );
  const legacy = shipmentOf(db, "s2");
  assert.equal(
    (
      await applyAutomation(
        legacy,
        decisionFor(legacy, { status: "Arrived", evidenceAt: iso(NOW) }),
        db,
      )
    ).outcome,
    "rejected",
  );
  assert.equal(shipmentOf(db).status, "In Transit");
  assert.equal(shipmentOf(db, "s2").status, "Delivered");
  assert.equal(eventsOf(db).length, 0);
});

// ===================================================================== rollback ====

await test("ROLLBACK on event failure: status, milestone and pending are exactly as before; no event, no alert, no stray writes", async () => {
  const db = departureReady();
  const s = { ...shipmentOf(db) };
  db.failInsert("shipment_events");
  await assert.rejects(
    applyAutomation(s, decisionFor(s, { stampActualDeparture: s.ais_pending_since }), db),
    /simulated shipment_events insert failure/,
  );
  const after = shipmentOf(db);
  assert.equal(after.status, "Booked");
  assert.equal(after.actual_departure, null);
  assert.equal(after.ais_pending_status, "Departed");
  assert.equal(after.ais_pending_since, s.ais_pending_since);
  assert.equal(eventsOf(db).length, 0);
  assert.equal(db.tables["alerts"]!.length, 0);
  assert.equal(db.writes.length, 0, "not even a partial write survives");
  // Nothing is stuck: once the fault clears, the same decision applies cleanly.
  assert.equal((await applyAutomation(s, decisionFor(s), db)).outcome, "applied");
  assert.equal(autoStatusEvents(db).length, 1);
});

await test("ROLLBACK on alert failure: the status change AND the already-written event are both undone", async () => {
  const db = departureReady();
  const s = { ...shipmentOf(db) };
  db.failInsert("alerts");
  await assert.rejects(applyAutomation(s, decisionFor(s), db), /simulated alerts insert failure/);
  assert.equal(shipmentOf(db).status, "Booked");
  assert.equal(shipmentOf(db).ais_pending_status, "Departed");
  assert.equal(eventsOf(db).length, 0, "no status_auto event without its status change");
  assert.equal(db.tables["alerts"]!.length, 0);
  assert.equal(db.writes.length, 0);
});

await test("ROLLBACK through the webhook: a failing event write surfaces as an error and leaves the shipment untouched (the pending candidate survives for the next report)", async () => {
  const db = departureReady();
  db.failInsert("shipment_events");
  await assert.rejects(evaluateAisPositionForMmsi("123456789", db, NOW), /simulated/);
  const s = shipmentOf(db);
  assert.equal(s.status, "Booked");
  assert.equal(s.ais_pending_status, "Departed");
  assert.equal(eventsOf(db).length, 0);
  // The next webhook (fault cleared) confirms normally.
  const r = await evaluateAisPositionForMmsi("123456789", db, NOW);
  assert.equal(r.updated, 1);
  assert.equal(shipmentOf(db).status, "Departed");
  assert.equal(autoStatusEvents(db).length, 1);
});

await test("ROLLBACK through the sweep: a failing event write on one shipment is an error, not a half-applied arrival", async () => {
  const db = makeFakeDb({
    shipments: asRows(
      makeShipment({ status: "In Transit", actual_arrival: iso(NOW - 60 * MINUTE) }),
    ),
  });
  db.failInsert("shipment_events", (r) => r["event_type"] === "status_auto");
  await runAutomationSweep(db as unknown as Db).catch(() => undefined);
  assert.notEqual(
    shipmentOf(db).status,
    "Arrived",
    "the status must not move without its history event",
  );
  assert.equal(autoStatusEvents(db).length, 0);
});

// ============================================================ actual timestamps ====

await test("AIS webhook: Booked -> Departed stamps actual_departure with the FIRST qualifying observation's AIS time, atomically with the transition", async () => {
  const db = departureReady();
  const pendingSince = shipmentOf(db).ais_pending_since;
  await evaluateAisPositionForMmsi("123456789", db, NOW);
  const s = shipmentOf(db);
  assert.equal(s.status, "Departed");
  assert.equal(s.actual_departure, pendingSince);
  assert.notEqual(s.actual_departure, iso(NOW), "not the time of the write");
  assert.equal(autoStatusEvents(db).length, 1);
});

await test("AIS webhook: Approaching -> Arrived stamps actual_arrival from the AIS observation time", async () => {
  const db = arrivalReady();
  const pendingSince = shipmentOf(db).ais_pending_since;
  await evaluateAisPositionForMmsi("123456789", db, NOW);
  const s = shipmentOf(db);
  assert.equal(s.status, "Arrived");
  assert.equal(s.actual_arrival, pendingSince);
  assert.equal(s.actual_departure, iso(NOW - 9 * DAY), "an existing departure is untouched");
});

await test("an operator-recorded actual_departure is never overwritten by an AIS stamp", async () => {
  const recorded = iso(NOW - 2 * DAY);
  const db = departureReady({ actual_departure: recorded });
  // A recorded departure would let the sweep advance it; here AIS gets there first.
  await evaluateAisPositionForMmsi("123456789", db, NOW);
  assert.equal(shipmentOf(db).status, "Departed");
  assert.equal(shipmentOf(db).actual_departure, recorded);
});

// ================================================================= operator hold ====

await test("manual BACKWARD correction: manual (not automated) event, pending cleared, hold set, contradicted milestone cleared, alert raised", async () => {
  const db = arrivalReady({ status: "Arrived", actual_arrival: iso(NOW - 60 * MINUTE) });
  await overrideStatus(
    shipmentOf(db),
    "Approaching Destination",
    "vessel is still outside the port",
    db,
  );
  const s = shipmentOf(db);
  assert.equal(s.status, "Approaching Destination");
  assert.equal(s.ais_pending_status, null);
  assert.equal(s.actual_arrival, null);
  assert.ok(s.automation_hold_until && new Date(s.automation_hold_until).getTime() > NOW);
  const ev = eventsOf(db);
  assert.equal(ev.length, 1);
  assert.equal(ev[0]!["source"], "manual");
  assert.equal(ev[0]!["automated"], false);
  assert.equal(ev[0]!["event_type"], "status_override");
  assert.match(String(ev[0]!["reason"]), /still outside the port/);
  assert.equal(db.tables["alerts"]!.length, 1);
});

await test("MANUAL CORRECTION cannot be immediately overwritten by an already-pending AIS candidate that would confirm on the very next report", async () => {
  const db = arrivalReady();
  await overrideStatus(shipmentOf(db), "In Transit", "not there yet", db);
  assert.equal(
    shipmentOf(db).ais_pending_status,
    null,
    "the candidate was voided by the correction",
  );
  // The very next webhook: position still stopped in the geofence, candidate would have confirmed.
  const r1 = await evaluateAisPositionForMmsi("123456789", db, NOW);
  const r2 = await evaluateAisPositionForMmsi("123456789", db, NOW + 20 * MINUTE);
  assert.equal(r1.updated + r2.updated, 0);
  const s = shipmentOf(db);
  assert.equal(s.status, "In Transit");
  assert.equal(s.ais_pending_status, null, "nothing banked during the hold");
  assert.equal(autoStatusEvents(db).length, 0);
  // Nor can the daily sweep undo it — even with a recorded arrival on file.
  Object.assign(s, { actual_arrival: iso(NOW - MINUTE) });
  await runAutomationSweep(db as unknown as Db);
  assert.equal(shipmentOf(db).status, "In Transit");
});

await test("natural hold expiry: evidence observed before the hold ended never starts a candidate — only observations after it do", async () => {
  const db = arrivalReady({
    status: "In Transit",
    ais_pending_status: null,
    ais_pending_since: null,
  });
  // A hold that ended 10 minutes ago; the latest position was observed 20 minutes ago (during the hold).
  shipmentOf(db).automation_hold_until = iso(NOW - 10 * MINUTE);
  const pos = db.tables["vessel_positions"]![0]!;
  pos["position_timestamp"] = iso(NOW - 20 * MINUTE);
  await evaluateAisPositionForMmsi("123456789", db, NOW);
  assert.equal(shipmentOf(db).ais_pending_status, null, "hold-time evidence is not banked");
  assert.equal(shipmentOf(db).status, "In Transit");

  // A genuinely new observation after the hold starts a candidate...
  pos["position_timestamp"] = iso(NOW - 2 * MINUTE);
  await evaluateAisPositionForMmsi("123456789", db, NOW);
  assert.equal(shipmentOf(db).ais_pending_status, "Approaching Destination");
  assert.equal(shipmentOf(db).ais_pending_since, iso(NOW - 2 * MINUTE));
  // ...which is not confirmed until a second distinct observation 15+ minutes later.
  assert.equal(autoStatusEvents(db).length, 0);
});

await test("explicit resume: the hold ends now (no longer in force), recorded as a manual event; a second resume is a no-op", async () => {
  const db = arrivalReady({ status: "Arrived" });
  await overrideStatus(shipmentOf(db), "In Transit", "test", db);
  assert.ok(shipmentOf(db).automation_hold_until);
  assert.equal(await resumeAutomation("s1", db), "applied");
  const s = shipmentOf(db);
  assert.ok(new Date(s.automation_hold_until!).getTime() <= Date.now(), "the hold is over");
  assert.equal(s.ais_pending_status, null);
  const resumed = eventsOf(db, (e) => e["event_type"] === "automation_resumed");
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0]!["automated"], false);
  assert.equal(resumed[0]!["source"], "manual");
  assert.equal(await resumeAutomation("s1", db), "noop");
  assert.equal(eventsOf(db, (e) => e["event_type"] === "automation_resumed").length, 1);
});

await test("CORRECTION -> HOLD -> RESUME -> an already-pending AIS candidate: it does NOT re-advance, and the same stale observation cannot start a new one", async () => {
  // Automation had a candidate one observation away from confirming Arrived.
  const db = arrivalReady();
  assert.equal(shipmentOf(db).ais_pending_status, "Arrived");
  await overrideStatus(shipmentOf(db), "In Transit", "not there yet", db);
  assert.equal(await resumeAutomation("s1", db), "applied");
  const s = shipmentOf(db);
  assert.equal(s.status, "In Transit");
  assert.equal(s.ais_pending_status, null, "the old candidate is gone");

  // Webhooks keep arriving; the stored position is still the OLD observation.
  for (const minutes of [0, 5, 20]) {
    const r = await evaluateAisPositionForMmsi("123456789", db, NOW + minutes * MINUTE);
    assert.equal(r.updated, 0);
    assert.equal(shipmentOf(db).status, "In Transit", `+${minutes}min: no re-advance`);
    assert.equal(
      shipmentOf(db).ais_pending_status,
      null,
      `+${minutes}min: the pre-resume observation starts nothing`,
    );
  }
  assert.equal(autoStatusEvents(db).length, 0);

  // Automation is eligible again — from NEW observations only.
  const resumedAt = new Date(shipmentOf(db).automation_hold_until!).getTime();
  const pos = db.tables["vessel_positions"]![0]!;
  pos["position_timestamp"] = iso(resumedAt + MINUTE);
  await evaluateAisPositionForMmsi("123456789", db, resumedAt + 3 * MINUTE);
  assert.equal(shipmentOf(db).ais_pending_status, "Approaching Destination");
  assert.equal(shipmentOf(db).ais_pending_since, iso(resumedAt + MINUTE));
  pos["position_timestamp"] = iso(resumedAt + 17 * MINUTE);
  const done = await evaluateAisPositionForMmsi("123456789", db, resumedAt + 18 * MINUTE);
  assert.equal(done.updated, 1);
  assert.equal(shipmentOf(db).status, "Approaching Destination");
  assert.equal(autoStatusEvents(db).length, 1);
  assert.equal(autoStatusEvents(db)[0]!["source"], "ais");
});

await test("a manual FORWARD change clears the pending candidate but does not hold automation", async () => {
  const db = departureReady();
  await advanceStatus(shipmentOf(db), db);
  const s = shipmentOf(db);
  assert.equal(s.status, "Departed");
  assert.equal(s.ais_pending_status, null);
  assert.equal(s.automation_hold_until ?? null, null);
  assert.equal(eventsOf(db)[0]!["source"], "manual");
  assert.equal(eventsOf(db)[0]!["automated"], false);
});

await test("advanceStatus is conditional: a stale page cannot regress a shipment automation has since moved", async () => {
  const db = departureReady();
  const stalePage = { ...shipmentOf(db), status: "Booked" as const };
  Object.assign(shipmentOf(db), { status: "In Transit" }); // automation moved it on meanwhile
  await assert.rejects(advanceStatus(stalePage, db), /status changed since the page loaded/);
  assert.equal(shipmentOf(db).status, "In Transit");
  assert.equal(eventsOf(db).length, 0);
});

await test("saveShipmentDetails routes a status edit through the manual-correction path (not a raw field update), alongside other field changes", async () => {
  const db = arrivalReady({ status: "Arrived", actual_arrival: iso(NOW - HOUR_MS) });
  await saveShipmentDetails(
    shipmentOf(db),
    { status: "In Transit", vessel_name: "Renamed" },
    "wrong port",
    db,
  );
  const s = shipmentOf(db);
  assert.equal(s.status, "In Transit");
  assert.equal(s.vessel_name, "Renamed");
  assert.ok(s.automation_hold_until, "a backward status edit holds automation");
  assert.equal(s.ais_pending_status, null);
  assert.ok(eventsOf(db, (e) => e["event_type"] === "status_override").length === 1);
  assert.ok(db.rpcCalls.some((c) => c.fn === "apply_manual_status_change"));
});

// ======================================================== pending invalidation ====

for (const [field, value] of [
  ["vessel_mmsi", "999999999"],
  ["origin_port_id", "another-origin"],
  ["destination_port_id", "another-destination"],
  ["planned_etd", iso(NOW + 5 * DAY)],
] as const) {
  await test(`pending AIS candidate is cleared when ${field} changes (through updateShipment and saveShipmentDetails)`, async () => {
    const db = departureReady();
    await updateShipment("s1", { [field]: value } as Partial<Shipment>, db);
    assert.equal(shipmentOf(db).ais_pending_status, null);
    assert.equal(shipmentOf(db).ais_pending_since, null);

    const db2 = departureReady();
    await saveShipmentDetails(shipmentOf(db2), { [field]: value } as Partial<Shipment>, null, db2);
    assert.equal(shipmentOf(db2).ais_pending_status, null);
  });
}

await test("...an unrelated edit does NOT disturb a pending candidate, and re-saving the same value doesn't either", async () => {
  const db = departureReady();
  const since = shipmentOf(db).ais_pending_since;
  await updateShipment("s1", { client_name: "Renamed", carrier: "Maersk" }, db);
  await updateShipment("s1", { vessel_mmsi: "123456789" }, db);
  assert.equal(shipmentOf(db).ais_pending_status, "Departed");
  assert.equal(shipmentOf(db).ais_pending_since, since);
});

await test("a candidate cleared by a vessel change cannot confirm from the OLD vessel's evidence: the next evaluation starts over", async () => {
  const db = departureReady();
  await updateShipment("s1", { vessel_mmsi: "555555555" }, db);
  const r = await evaluateAisPositionForMmsi("123456789", db, NOW); // old vessel, no longer linked
  assert.equal(r.evaluated, 0);
  assert.equal(shipmentOf(db).status, "Booked");
});

// ================================================================== the races ====

await test("RACE — two simultaneous webhooks confirming the same candidate -> exactly one transition, one history event, one alert", async () => {
  for (let offset = 0; offset <= 14; offset += 1) {
    const db = departureReady();
    const [a, b] = await Promise.all([
      evaluateAisPositionForMmsi("123456789", db, NOW),
      ticks(offset).then(() => evaluateAisPositionForMmsi("123456789", db, NOW)),
    ]);
    assert.equal(
      a.updated + b.updated,
      1,
      `offset ${offset}: exactly one webhook reports the transition`,
    );
    assert.equal(shipmentOf(db).status, "Departed", `offset ${offset}`);
    assert.equal(autoStatusEvents(db).length, 1, `offset ${offset}: one history event`);
    assert.equal(db.tables["alerts"]!.length, 1, `offset ${offset}: one alert`);
  }
});

await test("RACE — 25 simultaneous webhooks -> still exactly one event", async () => {
  const db = arrivalReady();
  const results = await Promise.all(
    Array.from({ length: 25 }, () => evaluateAisPositionForMmsi("123456789", db, NOW)),
  );
  assert.equal(
    results.reduce((n, r) => n + r.updated, 0),
    1,
  );
  assert.equal(autoStatusEvents(db).length, 1);
  assert.equal(shipmentOf(db).status, "Arrived");
  assert.equal(db.tables["alerts"]!.length, 1);
});

await test("RACE — scheduler sweep vs AIS webhook, both trying to make the same Approaching -> Arrived move -> exactly one transition and one event", async () => {
  for (let offset = 0; offset <= 20; offset += 1) {
    const db = arrivalReady({ actual_arrival: iso(NOW - 10 * MINUTE) });
    await Promise.all([
      runAutomationSweep(db as unknown as Db),
      ticks(offset).then(() => evaluateAisPositionForMmsi("123456789", db, NOW)),
    ]);
    assert.equal(shipmentOf(db).status, "Arrived", `offset ${offset}`);
    assert.equal(
      autoStatusEvents(db).length,
      1,
      `offset ${offset}: one history event, whichever writer won`,
    );
    assert.equal(db.tables["alerts"]!.length, 1, `offset ${offset}: one alert`);
  }
});

await test("RACE — the reverse start order (AIS first, sweep offset) gives the same single event", async () => {
  for (let offset = 0; offset <= 20; offset += 1) {
    const db = arrivalReady({ actual_arrival: iso(NOW - 10 * MINUTE) });
    await Promise.all([
      evaluateAisPositionForMmsi("123456789", db, NOW),
      ticks(offset).then(() => runAutomationSweep(db as unknown as Db)),
    ]);
    assert.equal(autoStatusEvents(db).length, 1, `offset ${offset}`);
    assert.equal(shipmentOf(db).status, "Arrived");
  }
});

await test("RACE — an operator's backward correction vs an in-flight AIS confirmation: the correction is always the final state, in every interleaving", async () => {
  for (let offset = 0; offset <= 24; offset += 1) {
    for (const correctionFirst of [true, false]) {
      const db = arrivalReady();
      const evaluate = () => evaluateAisPositionForMmsi("123456789", db, NOW);
      const correct = () =>
        overrideStatus(
          { ...shipmentOf(db), status: "Approaching Destination" },
          "In Transit",
          "not there yet",
          db,
        );
      await Promise.all(
        correctionFirst
          ? [correct(), ticks(offset).then(evaluate)]
          : [evaluate(), ticks(offset).then(correct)],
      );

      const s = shipmentOf(db);
      const label = `offset ${offset}, ${correctionFirst ? "correction" : "AIS"} first`;
      assert.equal(s.status, "In Transit", `${label}: the operator's correction stands`);
      assert.ok(s.automation_hold_until, `${label}: automation is on hold`);
      assert.equal(s.ais_pending_status, null, `${label}: no candidate left to fire`);
      // Nothing automated is recorded AFTER the manual correction.
      const order = eventsOf(db).map((e) => e["event_type"]);
      const at = order.lastIndexOf("status_override");
      assert.ok(at !== -1, `${label}: the correction is in the history`);
      assert.ok(
        !order.slice(at + 1).includes("status_auto"),
        `${label}: no automated transition after the correction`,
      );
      const events = eventsOf(db);
      assert.equal(
        events[events.length - 1]!["source"],
        "manual",
        `${label}: last word in the history is the operator's`,
      );
    }
  }
});

await test("RACE — while a correction is being made, a stream of webhooks never re-advances it", async () => {
  const db = arrivalReady();
  const correct = overrideStatus(shipmentOf(db), "In Transit", "test", db);
  const stream = Array.from({ length: 10 }, (_, i) =>
    ticks(i).then(() => evaluateAisPositionForMmsi("123456789", db, NOW + i * MINUTE)),
  );
  await Promise.all([correct, ...stream]);
  assert.equal(shipmentOf(db).status, "In Transit");
  assert.equal(eventsOf(db).filter((e) => e["event_type"] === "status_override").length, 1);
});

await test("RACE — the same webhook delivered twice, sequentially, after the transition: no second event (dedupe + compare-and-set)", async () => {
  const db = departureReady();
  await evaluateAisPositionForMmsi("123456789", db, NOW);
  await evaluateAisPositionForMmsi("123456789", db, NOW + MINUTE);
  await evaluateAisPositionForMmsi("123456789", db, NOW + 2 * MINUTE);
  assert.equal(autoStatusEvents(db).length, 1);
});

await test("applyAisDecision is a thin wrapper over applyAutomation (one authoritative write path): it produces the same RPC", async () => {
  const db = departureReady();
  const s = { ...shipmentOf(db) };
  const outcome = await applyAisDecision(
    s,
    {
      status: "Departed",
      monitoring_state: "Active Monitoring",
      reason: "r",
      source: "ais",
      statusChanged: true,
      monitoringChanged: false,
      pendingStatus: null,
      pendingSince: null,
      monitoringReason: "m",
      evidenceAt: s.ais_pending_since,
      stampActualDeparture: s.ais_pending_since,
      stampActualArrival: null,
    },
    db,
  );
  assert.equal(outcome.outcome, "applied");
  assert.equal(db.rpcCalls.length, 1);
  assert.equal(db.rpcCalls[0]!.fn, "apply_automation_decision");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
