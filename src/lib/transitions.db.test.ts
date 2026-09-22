/**
 * Database-level tests for the Phase 2 atomic transition functions. The REAL
 * migration file (supabase/migrations/20260923000000_atomic_shipment_transitions.sql)
 * is applied to a real Postgres engine (PGlite — Postgres compiled to WASM,
 * no server needed) on top of a mirror of the production schema, and the real
 * SQL functions and trigger are exercised — including failure injection to
 * prove rollback, and the TypeScript wrappers running against the real
 * functions. A final section runs the same scenarios through the in-memory
 * emulation the plumbing tests use and requires identical results.
 *
 * NOTE on concurrency: PGlite is single-connection, so calls made together
 * (Promise.all) are serialised by its queue — that verifies the compare-and-set
 * and dedupe logic, not lock behaviour. Row-lock behaviour under genuinely
 * simultaneous connections was verified separately against a real multi-connection
 * PostgreSQL server (see the Phase 2 report); a test here cannot do that without
 * a server dependency.
 *
 *   npx tsx src/lib/transitions.db.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";

import {
  applyAutomation,
  applyManualStatusChange,
  resumeAutomation,
  transitionDedupeKey,
  type Db,
  type Shipment,
} from "@/lib/api";
import { BASE_SCHEMA_SQL } from "@/lib/testkit/baseSchema";
import { makeFakeDb, type Row } from "@/lib/testkit/fakeDb";

const MIGRATION_SQL = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "..",
    "supabase",
    "migrations",
    "20260923000000_atomic_shipment_transitions.sql",
  ),
  "utf-8",
);

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

// ---------------------------------------------------------------- helpers ---

const T0 = "2026-09-21T22:00:00.000Z";
const T1 = "2026-09-21T23:00:00.000Z";
const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();
const anHourAgo = () => new Date(Date.now() - 3_600_000).toISOString();

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(BASE_SCHEMA_SQL);
  await db.exec(MIGRATION_SQL);
  return db;
}

const TYPES: Record<string, string> = {
  p_shipment_id: "uuid",
  p_expected_status: "public.shipment_status",
  p_new_status: "public.shipment_status",
  p_expected_pending_status: "public.shipment_status",
  p_new_pending_status: "public.shipment_status",
  p_expected_pending_since: "timestamptz",
  p_new_pending_since: "timestamptz",
  p_update_pending: "boolean",
  p_occurred_at: "timestamptz",
  p_stamp_actual_departure: "timestamptz",
  p_stamp_actual_arrival: "timestamptz",
};

async function callFn(
  db: PGlite,
  fn: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const keys = Object.keys(args);
  const sql = `SELECT public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}::${TYPES[k] ?? "text"}`).join(", ")}) AS r`;
  const res = await db.query<{ r: Record<string, unknown> }>(
    sql,
    keys.map((k) => args[k]),
  );
  return res.rows[0]!.r;
}

/** The Db the TypeScript wrappers use, backed by the real SQL functions. */
function pgliteDb(db: PGlite): Db {
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      try {
        return { data: await callFn(db, fn, args), error: null };
      } catch (e) {
        return { data: null, error: e instanceof Error ? e : new Error(String(e)) };
      }
    },
  } as unknown as Db;
}

const iso = (v: unknown) => (v == null ? null : new Date(v as string | Date).toISOString());

async function insertShipment(db: PGlite, o: Record<string, unknown> = {}): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO public.shipments (client_name, origin, destination, status, monitoring_state, planned_etd,
        ais_pending_status, ais_pending_since, actual_departure, actual_arrival, automation_hold_until, vessel_mmsi)
     VALUES ('Test','A','B', $1::public.shipment_status, $2, now() - interval '1 day',
        $3::public.shipment_status, $4::timestamptz, $5::timestamptz, $6::timestamptz, $7::timestamptz, $8)
     RETURNING id`,
    [
      o["status"] ?? "Booked",
      o["monitoring"] ?? "Active Monitoring",
      o["pendingStatus"] ?? null,
      o["pendingSince"] ?? null,
      o["actualDeparture"] ?? null,
      o["actualArrival"] ?? null,
      o["holdUntil"] ?? null,
      o["mmsi"] ?? null,
    ],
  );
  return r.rows[0]!.id;
}

async function getShipment(db: PGlite, id: string) {
  const r = await db.query<Record<string, unknown>>(
    "SELECT * FROM public.shipments WHERE id = $1",
    [id],
  );
  return r.rows[0]!;
}
async function asShipment(db: PGlite, id: string): Promise<Shipment> {
  const r = await getShipment(db, id);
  return {
    ...r,
    ais_pending_since: iso(r["ais_pending_since"]),
    actual_departure: iso(r["actual_departure"]),
    actual_arrival: iso(r["actual_arrival"]),
    automation_hold_until: iso(r["automation_hold_until"]),
    planned_etd: iso(r["planned_etd"]),
  } as unknown as Shipment;
}
const count = async (db: PGlite, table: string, id: string, where = "TRUE") =>
  Number(
    (
      await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.${table} WHERE shipment_id = $1 AND ${where}`,
        [id],
      )
    ).rows[0]!.n,
  );

/** A Booked -> Departed AIS decision with a pending candidate first observed at T0. */
const decision = (id: string, over: Record<string, unknown> = {}) => ({
  p_shipment_id: id,
  p_expected_status: "Booked",
  p_new_status: "Departed",
  p_expected_monitoring_state: "Active Monitoring",
  p_new_monitoring_state: "Active Monitoring",
  p_expected_pending_status: "Departed",
  p_expected_pending_since: T0,
  p_new_pending_status: null,
  p_new_pending_since: null,
  p_update_pending: true,
  p_source: "ais",
  p_actor: "Automation",
  p_reason: "AIS test",
  p_status_dedupe_key: `status:${id}:Booked>Departed:ais:${T0}`,
  p_stamp_actual_departure: T0,
  p_alert_message: "auto moved",
  ...over,
});

// ================================================================ schema ====

await test("the migration applies cleanly on top of the production schema, and is idempotent", async () => {
  const db = await freshDb();
  await db.exec(MIGRATION_SQL);
  await db.exec(MIGRATION_SQL);
  const fns = await db.query<{ proname: string }>(
    `SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND proname IN ('apply_automation_decision','apply_manual_status_change','resume_shipment_automation','shipments_guard_automation_state')
      ORDER BY 1`,
  );
  assert.equal(fns.rows.length, 4);
  const idx = await db.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE indexname LIKE '%dedupe_key%' ORDER BY 1`,
  );
  assert.deepEqual(
    idx.rows.map((r) => r.indexname),
    ["alerts_dedupe_key_idx", "shipment_events_dedupe_key_idx"],
  );
  await db.close();
});

await test("existing rows are untouched by the migration (NULL keys, NULL hold)", async () => {
  const db = new PGlite();
  await db.exec(BASE_SCHEMA_SQL);
  const id = (
    await db.query<{ id: string }>(
      `INSERT INTO public.shipments (client_name, origin, destination) VALUES ('a','b','c') RETURNING id`,
    )
  ).rows[0]!.id;
  await db.query(
    `INSERT INTO public.shipment_events (shipment_id, event_type) VALUES ($1,'old'),($1,'old')`,
    [id],
  );
  await db.exec(MIGRATION_SQL);
  const ev = await db.query<{ dedupe_key: string | null }>(
    `SELECT dedupe_key FROM public.shipment_events`,
  );
  assert.deepEqual(
    ev.rows.map((r) => r.dedupe_key),
    [null, null],
  );
  assert.equal((await getShipment(db, id))["automation_hold_until"], null);
  await db.close();
});

// ====================================================== compare-and-set ====

const db1 = await freshDb();

await test("compare-and-set: the transition applies once; the same call again is a conflict and writes nothing more", async () => {
  const id = await insertShipment(db1, { pendingStatus: "Departed", pendingSince: T0 });
  const first = await callFn(db1, "apply_automation_decision", decision(id));
  assert.equal(first["outcome"], "applied");
  const second = await callFn(db1, "apply_automation_decision", decision(id));
  assert.equal(second["outcome"], "conflict");
  assert.equal(await count(db1, "shipment_events", id, "event_type = 'status_auto'"), 1);
  assert.equal(await count(db1, "alerts", id), 1);
  assert.equal((await getShipment(db1, id))["status"], "Departed");
});

await test("SIMULTANEOUS attempts at the same logical transition -> exactly one transition and exactly one history event (serialised queue; real locks: see harness)", async () => {
  const id = await insertShipment(db1, { pendingStatus: "Departed", pendingSince: T0 });
  const results = await Promise.all(
    Array.from({ length: 12 }, () => callFn(db1, "apply_automation_decision", decision(id))),
  );
  assert.equal(results.filter((r) => r["outcome"] === "applied").length, 1);
  assert.ok(
    results.filter((r) => r["outcome"] !== "applied").every((r) => r["outcome"] === "conflict"),
  );
  assert.equal(await count(db1, "shipment_events", id, "event_type = 'status_auto'"), 1);
  assert.equal(await count(db1, "alerts", id), 1);
});

await test("the dedupe key alone stops a repeat of the same logical transition (even with compare-and-set out of the picture)", async () => {
  const id = await insertShipment(db1, { pendingStatus: "Departed", pendingSince: T0 });
  assert.equal(
    (await callFn(db1, "apply_automation_decision", decision(id)))["outcome"],
    "applied",
  );
  // Put the shipment back exactly as automation would, so only the key stands in the way.
  await db1.exec("BEGIN");
  await db1.exec("SELECT set_config('whitewind.transition_source','automation',true)");
  await db1.query(
    `UPDATE public.shipments SET status='Booked', ais_pending_status='Departed', ais_pending_since=$2 WHERE id=$1`,
    [id, T0],
  );
  await db1.exec("COMMIT");
  assert.equal(
    (await callFn(db1, "apply_automation_decision", decision(id)))["outcome"],
    "duplicate",
  );
  assert.equal(await count(db1, "shipment_events", id, "event_type = 'status_auto'"), 1);
});

await test("the unique index makes a duplicate key impossible; NULL keys (manual/legacy events) never collide", async () => {
  const id = await insertShipment(db1);
  const ins = `INSERT INTO public.shipment_events (shipment_id, event_type, dedupe_key) VALUES ($1,'x','same')`;
  await db1.query(ins, [id]);
  await assert.rejects(db1.query(ins, [id]), /duplicate key value/);
  await db1.query(
    `INSERT INTO public.shipment_events (shipment_id, event_type) VALUES ($1,'m'),($1,'m')`,
    [id],
  );
});

await test("distinct lifecycle transitions are all recorded (different keys, never blocked)", async () => {
  const id = await insertShipment(db1, { pendingStatus: "Departed", pendingSince: T0 });
  assert.equal(
    (await callFn(db1, "apply_automation_decision", decision(id)))["outcome"],
    "applied",
  );
  await db1.query(
    `UPDATE public.shipments SET ais_pending_status='In Transit', ais_pending_since=$2 WHERE id=$1`,
    [id, T1],
  );
  const next = await callFn(
    db1,
    "apply_automation_decision",
    decision(id, {
      p_expected_status: "Departed",
      p_new_status: "In Transit",
      p_expected_pending_status: "In Transit",
      p_expected_pending_since: T1,
      p_status_dedupe_key: `status:${id}:Departed>In Transit:ais:${T1}`,
      p_stamp_actual_departure: null,
    }),
  );
  assert.equal(next["outcome"], "applied");
  const events = await db1.query<{ from_value: string; to_value: string }>(
    `SELECT from_value, to_value FROM public.shipment_events WHERE shipment_id=$1 AND event_type='status_auto' ORDER BY occurred_at, created_at`,
    [id],
  );
  assert.equal(events.rows.length, 2);
});

await test("a stale pending candidate cannot be written over a changed one (pending is compare-and-set too)", async () => {
  const id = await insertShipment(db1, { pendingStatus: "Departed", pendingSince: T1 });
  const stale = await callFn(
    db1,
    "apply_automation_decision",
    decision(id, {
      p_new_status: "Booked",
      p_expected_pending_since: T0,
      p_new_pending_status: "Departed",
      p_new_pending_since: "2026-09-22T00:00:00.000Z",
      p_status_dedupe_key: null,
    }),
  );
  assert.equal(stale["outcome"], "conflict");
  assert.equal(iso((await getShipment(db1, id))["ais_pending_since"]), T1);
});

await test("automation only ever moves a shipment FORWARD between active statuses", async () => {
  const id = await insertShipment(db1, { status: "In Transit" });
  for (const [to, why] of [
    ["Booked", "backward"],
    ["In Transit", "noop"],
    ["Delivered", "legacy target"],
  ] as const) {
    const r = await callFn(
      db1,
      "apply_automation_decision",
      decision(id, {
        p_expected_status: "In Transit",
        p_new_status: to,
        p_update_pending: false,
        p_status_dedupe_key: null,
        p_stamp_actual_departure: null,
      }),
    );
    assert.notEqual(r["outcome"], "applied", why);
  }
  const legacy = await insertShipment(db1, { status: "Delivered" });
  const r = await callFn(
    db1,
    "apply_automation_decision",
    decision(legacy, {
      p_expected_status: "Delivered",
      p_new_status: "Arrived",
      p_update_pending: false,
      p_status_dedupe_key: null,
    }),
  );
  assert.equal(r["outcome"], "rejected", "a retired legacy status is never touched");
  assert.equal((await getShipment(db1, id))["status"], "In Transit");
});

await test("noop and not_found", async () => {
  const id = await insertShipment(db1);
  const same = await callFn(
    db1,
    "apply_automation_decision",
    decision(id, { p_new_status: "Booked", p_update_pending: false }),
  );
  assert.equal(same["outcome"], "noop");
  const missing = await callFn(
    db1,
    "apply_automation_decision",
    decision("00000000-0000-0000-0000-000000000000"),
  );
  assert.equal(missing["outcome"], "not_found");
});

await test("monitoring-only change is applied once and recorded with its OWN reason; a lost race skips it quietly", async () => {
  const id = await insertShipment(db1, { monitoring: "Scheduled" });
  const args = {
    p_shipment_id: id,
    p_expected_status: "Booked",
    p_new_status: "Booked",
    p_expected_monitoring_state: "Scheduled",
    p_new_monitoring_state: "Active Monitoring",
    p_reason: "AIS evidence text",
    p_monitoring_reason: "Inside the monitoring window for the planned departure",
  };
  assert.equal((await callFn(db1, "apply_automation_decision", args))["outcome"], "applied");
  assert.equal(
    (await callFn(db1, "apply_automation_decision", args))["outcome"],
    "applied",
    "second caller: nothing left to do for monitoring, no error",
  );
  const ev = await db1.query<{ reason: string }>(
    `SELECT reason FROM public.shipment_events WHERE shipment_id=$1 AND event_type='monitoring_auto'`,
    [id],
  );
  assert.equal(ev.rows.length, 1, "recorded exactly once");
  assert.equal(
    ev.rows[0]!.reason,
    "Inside the monitoring window for the planned departure",
    "not the AIS evidence text",
  );
});

// ================================================== actual date stamping ====

await test("Booked -> Departed stamps actual_departure from the AIS observation time, not the write time", async () => {
  const id = await insertShipment(db1, { pendingStatus: "Departed", pendingSince: T0 });
  await callFn(db1, "apply_automation_decision", decision(id));
  const s = await getShipment(db1, id);
  assert.equal(iso(s["actual_departure"]), T0);
  assert.equal(s["actual_arrival"], null);
});

await test("Approaching -> Arrived stamps actual_arrival; other transitions stamp nothing", async () => {
  const id = await insertShipment(db1, {
    status: "Approaching Destination",
    pendingStatus: "Arrived",
    pendingSince: T1,
  });
  await callFn(
    db1,
    "apply_automation_decision",
    decision(id, {
      p_expected_status: "Approaching Destination",
      p_new_status: "Arrived",
      p_expected_pending_status: "Arrived",
      p_expected_pending_since: T1,
      p_status_dedupe_key: `status:${id}:AD>A:${T1}`,
      p_stamp_actual_departure: null,
      p_stamp_actual_arrival: T1,
    }),
  );
  const s = await getShipment(db1, id);
  assert.equal(iso(s["actual_arrival"]), T1);
  assert.equal(s["actual_departure"], null);

  const t = await insertShipment(db1, {
    status: "Departed",
    pendingStatus: "In Transit",
    pendingSince: T0,
  });
  await callFn(
    db1,
    "apply_automation_decision",
    decision(t, {
      p_expected_status: "Departed",
      p_new_status: "In Transit",
      p_expected_pending_status: "In Transit",
      p_status_dedupe_key: `status:${t}:D>IT`,
      p_stamp_actual_departure: null,
    }),
  );
  const ts = await getShipment(db1, t);
  assert.equal(ts["actual_departure"], null);
  assert.equal(ts["actual_arrival"], null);
});

await test("a stamp never overwrites a value an operator already recorded", async () => {
  const recorded = "2026-09-20T08:30:00.000Z";
  const id = await insertShipment(db1, {
    pendingStatus: "Departed",
    pendingSince: T0,
    actualDeparture: recorded,
  });
  await callFn(db1, "apply_automation_decision", decision(id));
  assert.equal(iso((await getShipment(db1, id))["actual_departure"]), recorded);
});

// ======================================================== operator hold ====

await test("while an operator hold is in force, automation writes nothing — no status change, no pending candidate", async () => {
  const id = await insertShipment(db1, { holdUntil: inAnHour(), pendingStatus: null });
  const advance = await callFn(
    db1,
    "apply_automation_decision",
    decision(id, { p_expected_pending_status: null, p_expected_pending_since: null }),
  );
  assert.equal(advance["outcome"], "held");
  const pendingOnly = await callFn(
    db1,
    "apply_automation_decision",
    decision(id, {
      p_new_status: "Booked",
      p_expected_pending_status: null,
      p_expected_pending_since: null,
      p_new_pending_status: "Departed",
      p_new_pending_since: T0,
      p_status_dedupe_key: null,
    }),
  );
  assert.equal(pendingOnly["outcome"], "held");
  const s = await getShipment(db1, id);
  assert.equal(s["status"], "Booked");
  assert.equal(s["ais_pending_status"], null);
  assert.equal(await count(db1, "shipment_events", id), 0);
});

await test("...but monitoring-state upkeep still runs during a hold, and automation resumes once the hold expires", async () => {
  const id = await insertShipment(db1, { holdUntil: inAnHour(), monitoring: "Scheduled" });
  const m = await callFn(db1, "apply_automation_decision", {
    p_shipment_id: id,
    p_expected_status: "Booked",
    p_new_status: "Booked",
    p_expected_monitoring_state: "Scheduled",
    p_new_monitoring_state: "Active Monitoring",
  });
  assert.equal(m["outcome"], "applied");
  await db1.query(`UPDATE public.shipments SET automation_hold_until = $2 WHERE id=$1`, [
    id,
    anHourAgo(),
  ]);
  await db1.query(
    `UPDATE public.shipments SET ais_pending_status='Departed', ais_pending_since=$2 WHERE id=$1`,
    [id, T0],
  );
  assert.equal(
    (await callFn(db1, "apply_automation_decision", decision(id)))["outcome"],
    "applied",
  );
});

await test("a manual BACKWARD correction: manual event, pending voided, hold set, contradicted milestone dates cleared", async () => {
  const id = await insertShipment(db1, {
    status: "Arrived",
    actualDeparture: T0,
    actualArrival: T1,
    pendingStatus: null,
  });
  const r = await callFn(db1, "apply_manual_status_change", {
    p_shipment_id: id,
    p_new_status: "Approaching Destination",
    p_event_type: "status_override",
    p_reason: "vessel is still outside the port",
    p_alert_message: "manually overridden",
  });
  assert.equal(r["outcome"], "applied");
  assert.equal(r["backward"], true);
  assert.equal(r["cleared_actual_arrival"], true);
  assert.equal(
    r["cleared_actual_departure"],
    false,
    "still consistent with Approaching Destination",
  );
  const s = await getShipment(db1, id);
  assert.equal(s["status"], "Approaching Destination");
  assert.equal(s["actual_arrival"], null);
  assert.equal(iso(s["actual_departure"]), T0);
  assert.ok(new Date(s["automation_hold_until"] as string) > new Date(), "hold in force");
  const ev = await db1.query<Record<string, unknown>>(
    `SELECT * FROM public.shipment_events WHERE shipment_id=$1`,
    [id],
  );
  assert.equal(ev.rows.length, 1);
  const e = ev.rows[0]!;
  assert.equal(e["source"], "manual");
  assert.equal(e["automated"], false);
  assert.equal(e["actor"], "Operator");
  assert.equal(e["dedupe_key"], null);
  assert.match(String(e["reason"]), /vessel is still outside the port/);
  assert.match(String(e["reason"]), /Cleared actual_arrival/);
  assert.equal(await count(db1, "alerts", id), 1);
});

await test("a manual correction below Departed clears both milestone dates", async () => {
  const id = await insertShipment(db1, { status: "In Transit", actualDeparture: T0 });
  const r = await callFn(db1, "apply_manual_status_change", {
    p_shipment_id: id,
    p_new_status: "Booked",
  });
  assert.equal(r["cleared_actual_departure"], true);
  assert.equal((await getShipment(db1, id))["actual_departure"], null);
});

await test("a manual FORWARD change voids pending but does not hold automation (automation could not undo it)", async () => {
  const id = await insertShipment(db1, { pendingStatus: "Departed", pendingSince: T0 });
  const r = await callFn(db1, "apply_manual_status_change", {
    p_shipment_id: id,
    p_new_status: "Departed",
    p_expected_status: "Booked",
    p_event_type: "status_manual",
  });
  assert.equal(r["outcome"], "applied");
  assert.equal(r["backward"], false);
  const s = await getShipment(db1, id);
  assert.equal(s["ais_pending_status"], null);
  assert.equal(s["automation_hold_until"], null);
});

await test("advance is conditional on the status the operator saw: a stale page cannot regress a shipment automation moved on", async () => {
  const id = await insertShipment(db1, { status: "In Transit" });
  const r = await callFn(db1, "apply_manual_status_change", {
    p_shipment_id: id,
    p_new_status: "Departed",
    p_expected_status: "Booked",
    p_event_type: "status_manual",
  });
  assert.equal(r["outcome"], "conflict");
  assert.equal((await getShipment(db1, id))["status"], "In Transit");
  assert.equal(await count(db1, "shipment_events", id), 0);
});

await test("MANUAL CORRECTION vs an already-pending AIS candidate: the candidate can never overwrite the correction", async () => {
  const id = await insertShipment(db1, {
    status: "Approaching Destination",
    pendingStatus: "Arrived",
    pendingSince: T0,
  });
  // The in-flight evaluation (snapshot taken before the operator acted):
  const inFlight = decision(id, {
    p_expected_status: "Approaching Destination",
    p_new_status: "Arrived",
    p_expected_pending_status: "Arrived",
    p_status_dedupe_key: `status:${id}:AD>A:${T0}`,
    p_stamp_actual_departure: null,
    p_stamp_actual_arrival: T0,
  });
  await callFn(db1, "apply_manual_status_change", {
    p_shipment_id: id,
    p_new_status: "In Transit",
    p_reason: "not there yet",
  });
  const late = await callFn(db1, "apply_automation_decision", inFlight);
  assert.notEqual(late["outcome"], "applied");
  // ...and a freshly evaluated candidate for the corrected status is held, not recorded.
  const fresh = await callFn(db1, "apply_automation_decision", {
    p_shipment_id: id,
    p_expected_status: "In Transit",
    p_new_status: "In Transit",
    p_expected_monitoring_state: "Active Monitoring",
    p_new_monitoring_state: "Active Monitoring",
    p_expected_pending_status: null,
    p_expected_pending_since: null,
    p_new_pending_status: "Approaching Destination",
    p_new_pending_since: T1,
    p_update_pending: true,
  });
  assert.equal(fresh["outcome"], "held");
  const s = await getShipment(db1, id);
  assert.equal(s["status"], "In Transit");
  assert.equal(s["ais_pending_status"], null);
  assert.equal(s["actual_arrival"], null);
  assert.equal(await count(db1, "shipment_events", id, "automated = true"), 0);
});

await test("an operator can lift a hold early: recorded as a manual event, the hold ends now, and the pending candidate is voided", async () => {
  const id = await insertShipment(db1, {
    holdUntil: inAnHour(),
    pendingStatus: "Departed",
    pendingSince: T0,
  });
  const before = Date.now();
  const r = await callFn(db1, "resume_shipment_automation", { p_shipment_id: id });
  assert.equal(r["outcome"], "applied");
  const s = await getShipment(db1, id);
  const boundary = new Date(s["automation_hold_until"] as string).getTime();
  assert.ok(
    boundary <= Date.now() && boundary >= before - 5000,
    "hold ends at the resume instant — no longer in force",
  );
  assert.equal(s["ais_pending_status"], null);
  assert.equal(s["ais_pending_since"], null);
  const ev = await db1.query<{ event_type: string; source: string; automated: boolean }>(
    `SELECT event_type, source, automated FROM public.shipment_events WHERE shipment_id=$1`,
    [id],
  );
  assert.deepEqual(ev.rows, [
    { event_type: "automation_resumed", source: "manual", automated: false },
  ]);
  assert.equal(
    (await callFn(db1, "resume_shipment_automation", { p_shipment_id: id }))["outcome"],
    "noop",
    "a second resume is a no-op (no active hold), not a second event",
  );
  assert.equal(await count(db1, "shipment_events", id), 1);
});

await test("resume with no hold, an expired hold, or an unknown shipment is a safe no-op / not_found", async () => {
  const none = await insertShipment(db1);
  assert.equal(
    (await callFn(db1, "resume_shipment_automation", { p_shipment_id: none }))["outcome"],
    "noop",
  );
  const expired = await insertShipment(db1, { holdUntil: anHourAgo() });
  assert.equal(
    (await callFn(db1, "resume_shipment_automation", { p_shipment_id: expired }))["outcome"],
    "noop",
  );
  assert.equal(
    (
      await callFn(db1, "resume_shipment_automation", {
        p_shipment_id: "00000000-0000-0000-0000-000000000000",
      })
    )["outcome"],
    "not_found",
  );
  assert.equal(await count(db1, "shipment_events", none), 0);
  assert.equal(await count(db1, "shipment_events", expired), 0);
});

await test("CORRECTION -> HOLD -> RESUME: the old pending candidate cannot re-advance, and evidence from before the resume cannot start a new one", async () => {
  // A shipment automation had already moved to Arrived, with a pending candidate.
  const id = await insertShipment(db1, {
    status: "Approaching Destination",
    pendingStatus: "Arrived",
    pendingSince: T0,
  });
  const inFlight = decision(id, {
    p_expected_status: "Approaching Destination",
    p_new_status: "Arrived",
    p_expected_pending_status: "Arrived",
    p_status_dedupe_key: `status:${id}:AD>A:${T0}`,
    p_stamp_actual_departure: null,
    p_stamp_actual_arrival: T0,
  });
  await callFn(db1, "apply_manual_status_change", {
    p_shipment_id: id,
    p_new_status: "In Transit",
    p_reason: "not there yet",
  });
  assert.equal(
    (await getShipment(db1, id))["ais_pending_status"],
    null,
    "correction voids the candidate",
  );
  assert.equal(
    (await callFn(db1, "resume_shipment_automation", { p_shipment_id: id }))["outcome"],
    "applied",
  );

  // 1. The candidate that was pending before the correction: gone (CAS/status).
  assert.notEqual((await callFn(db1, "apply_automation_decision", inFlight))["outcome"], "applied");

  // 2. An observation taken BEFORE the resume cannot start a new candidate.
  const stale = await callFn(db1, "apply_automation_decision", {
    p_shipment_id: id,
    p_expected_status: "In Transit",
    p_new_status: "In Transit",
    p_expected_monitoring_state: "Active Monitoring",
    p_new_monitoring_state: "Active Monitoring",
    p_expected_pending_status: null,
    p_expected_pending_since: null,
    p_new_pending_status: "Approaching Destination",
    p_new_pending_since: T1,
    p_update_pending: true,
  });
  assert.equal(stale["outcome"], "held");
  assert.equal(stale["reason"], "evidence_predates_hold");

  // 3. An observation taken AFTER the resume starts one normally.
  const fresh = await callFn(db1, "apply_automation_decision", {
    p_shipment_id: id,
    p_expected_status: "In Transit",
    p_new_status: "In Transit",
    p_expected_monitoring_state: "Active Monitoring",
    p_new_monitoring_state: "Active Monitoring",
    p_expected_pending_status: null,
    p_expected_pending_since: null,
    p_new_pending_status: "Approaching Destination",
    p_new_pending_since: new Date(Date.now() + 60_000).toISOString(),
    p_update_pending: true,
  });
  assert.equal(fresh["outcome"], "applied");
  const s = await getShipment(db1, id);
  assert.equal(s["status"], "In Transit");
  assert.equal(s["ais_pending_status"], "Approaching Destination");
  assert.equal(
    await count(db1, "shipment_events", id, "automated = true"),
    0,
    "automation recorded nothing while doing this",
  );
});

await test("the hold length is a workspace setting (automation_hold_hours), 0 disables it", async () => {
  await db1.query(
    `INSERT INTO public.app_settings (key, value) VALUES ('automation_hold_hours', '0'::jsonb)`,
  );
  const id = await insertShipment(db1, { status: "In Transit" });
  const r = await callFn(db1, "apply_manual_status_change", {
    p_shipment_id: id,
    p_new_status: "Booked",
  });
  assert.equal(r["outcome"], "applied");
  assert.equal((await getShipment(db1, id))["automation_hold_until"], null);
  await db1.query(
    `UPDATE public.app_settings SET value='6'::jsonb WHERE key='automation_hold_hours'`,
  );
  const id2 = await insertShipment(db1, { status: "In Transit" });
  await callFn(db1, "apply_manual_status_change", { p_shipment_id: id2, p_new_status: "Booked" });
  const hold =
    new Date((await getShipment(db1, id2))["automation_hold_until"] as string).getTime() -
    Date.now();
  assert.ok(hold > 5.9 * 3_600_000 && hold <= 6 * 3_600_000, `hold was ${hold / 3_600_000} h`);
  await db1.query(`DELETE FROM public.app_settings WHERE key='automation_hold_hours'`);
});

// ======================================================== stale candidates ====

await test("pending candidate is voided when vessel_mmsi, origin_port_id, destination_port_id or planned_etd changes", async () => {
  const cases: Array<[string, string]> = [
    ["vessel_mmsi", "'999999999'"],
    ["origin_port_id", "gen_random_uuid()"],
    ["destination_port_id", "gen_random_uuid()"],
    ["planned_etd", "now() + interval '3 days'"],
  ];
  for (const [col, value] of cases) {
    const id = await insertShipment(db1, { pendingStatus: "Departed", pendingSince: T0 });
    await db1.query(`UPDATE public.shipments SET ${col} = ${value} WHERE id = $1`, [id]);
    const s = await getShipment(db1, id);
    assert.equal(s["ais_pending_status"], null, col);
    assert.equal(s["ais_pending_since"], null, col);
  }
});

await test("...and an unrelated edit leaves a pending candidate alone", async () => {
  const id = await insertShipment(db1, { pendingStatus: "Departed", pendingSince: T0 });
  await db1.query(
    `UPDATE public.shipments SET client_name='Renamed', landed_cost=10, eta=now() WHERE id=$1`,
    [id],
  );
  const s = await getShipment(db1, id);
  assert.equal(s["ais_pending_status"], "Departed");
  assert.equal(iso(s["ais_pending_since"]), T0);
});

await test("a status change that BYPASSES the functions is still treated as an operator decision (guard trigger)", async () => {
  const back = await insertShipment(db1, {
    status: "Arrived",
    pendingStatus: "Arrived",
    pendingSince: T0,
  });
  await db1.query(`UPDATE public.shipments SET status='In Transit' WHERE id=$1`, [back]);
  let s = await getShipment(db1, back);
  assert.equal(s["ais_pending_status"], null);
  assert.ok(
    new Date(s["automation_hold_until"] as string) > new Date(),
    "backward raw update puts automation on hold",
  );

  const fwd = await insertShipment(db1, { pendingStatus: "Departed", pendingSince: T0 });
  await db1.query(`UPDATE public.shipments SET status='Departed' WHERE id=$1`, [fwd]);
  s = await getShipment(db1, fwd);
  assert.equal(s["ais_pending_status"], null);
  assert.equal(s["automation_hold_until"], null);
});

await test("automation's own status change does NOT set a hold on itself", async () => {
  const id = await insertShipment(db1, { pendingStatus: "Departed", pendingSince: T0 });
  await callFn(db1, "apply_automation_decision", decision(id));
  assert.equal((await getShipment(db1, id))["automation_hold_until"], null);
});

// ============================================================== rollback ====

await test("ROLLBACK: if the event insert fails, the status change is undone — never a status change without its history", async () => {
  const id = await insertShipment(db1, { pendingStatus: "Departed", pendingSince: T0 });
  await db1.exec(`CREATE OR REPLACE FUNCTION public.t_fail_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='status_auto' THEN RAISE EXCEPTION 'simulated event failure'; END IF; RETURN NEW; END $$;
                  CREATE TRIGGER t_fail_event BEFORE INSERT ON public.shipment_events FOR EACH ROW EXECUTE FUNCTION public.t_fail_event();`);
  await assert.rejects(
    callFn(db1, "apply_automation_decision", decision(id)),
    /simulated event failure/,
  );
  const s = await getShipment(db1, id);
  assert.equal(s["status"], "Booked");
  assert.equal(s["actual_departure"], null);
  assert.equal(s["ais_pending_status"], "Departed");
  assert.equal(await count(db1, "shipment_events", id), 0);
  assert.equal(await count(db1, "alerts", id), 0);
  await db1.exec("DROP TRIGGER t_fail_event ON public.shipment_events");
  assert.equal(
    (await callFn(db1, "apply_automation_decision", decision(id)))["outcome"],
    "applied",
    "recovers cleanly once the fault clears",
  );
});

await test("ROLLBACK: if the ALERT insert fails, the status change and the event are both undone", async () => {
  const id = await insertShipment(db1, { pendingStatus: "Departed", pendingSince: T0 });
  await db1.exec(`CREATE OR REPLACE FUNCTION public.t_fail_alert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated alert failure'; END $$;
                  CREATE TRIGGER t_fail_alert BEFORE INSERT ON public.alerts FOR EACH ROW EXECUTE FUNCTION public.t_fail_alert();`);
  await assert.rejects(
    callFn(db1, "apply_automation_decision", decision(id)),
    /simulated alert failure/,
  );
  const s = await getShipment(db1, id);
  assert.equal(s["status"], "Booked");
  assert.equal(s["actual_departure"], null);
  assert.equal(
    await count(db1, "shipment_events", id),
    0,
    "the event written before the failure is rolled back too",
  );
  await db1.exec("DROP TRIGGER t_fail_alert ON public.alerts");
});

await test("ROLLBACK: a failing manual correction leaves the shipment exactly as it was (status, hold, milestones, pending)", async () => {
  const id = await insertShipment(db1, {
    status: "Arrived",
    actualArrival: T1,
    pendingStatus: null,
  });
  await db1.exec(`CREATE OR REPLACE FUNCTION public.t_fail_manual() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated manual failure'; END $$;
                  CREATE TRIGGER t_fail_manual BEFORE INSERT ON public.shipment_events FOR EACH ROW EXECUTE FUNCTION public.t_fail_manual();`);
  await assert.rejects(
    callFn(db1, "apply_manual_status_change", { p_shipment_id: id, p_new_status: "In Transit" }),
    /simulated manual failure/,
  );
  const s = await getShipment(db1, id);
  assert.equal(s["status"], "Arrived");
  assert.equal(s["automation_hold_until"], null);
  assert.equal(iso(s["actual_arrival"]), T1);
  await db1.exec("DROP TRIGGER t_fail_manual ON public.shipment_events");
});

// ======================================== the TypeScript wrappers on real SQL ====

await test("applyAutomation() (TypeScript) -> real SQL: builds the deterministic dedupe key, stamps from the AIS observation, one event, one alert", async () => {
  const id = await insertShipment(db1, { pendingStatus: "Departed", pendingSince: T0 });
  const shipment = await asShipment(db1, id);
  const outcome = await applyAutomation(
    shipment,
    {
      status: "Departed",
      monitoring_state: "Active Monitoring",
      reason: "AIS shows the vessel departing",
      source: "ais",
      statusChanged: true,
      monitoringChanged: false,
      pending: { status: null, since: null },
      evidenceAt: shipment.ais_pending_since,
      stampActualDeparture: shipment.ais_pending_since,
    },
    pgliteDb(db1),
  );
  assert.deepEqual(outcome, {
    outcome: "applied",
    statusChanged: true,
    monitoringChanged: false,
    pendingChanged: true,
  });
  const ev = await db1.query<{ dedupe_key: string; source: string; reason: string }>(
    `SELECT dedupe_key, source, reason FROM public.shipment_events WHERE shipment_id=$1`,
    [id],
  );
  assert.equal(ev.rows[0]!.dedupe_key, transitionDedupeKey(id, "Booked", "Departed", "ais", T0));
  assert.equal(ev.rows[0]!.dedupe_key, `status:${id}:Booked>Departed:ais:${T0}`);
  assert.equal(iso((await getShipment(db1, id))["actual_departure"]), T0);

  // The same decision applied again — from the same stale snapshot — writes nothing.
  const again = await applyAutomation(
    shipment,
    {
      status: "Departed",
      monitoring_state: "Active Monitoring",
      reason: "AIS shows the vessel departing",
      source: "ais",
      statusChanged: true,
      monitoringChanged: false,
      pending: { status: null, since: null },
      evidenceAt: shipment.ais_pending_since,
    },
    pgliteDb(db1),
  );
  assert.equal(again.outcome, "conflict");
  assert.equal(await count(db1, "shipment_events", id, "event_type='status_auto'"), 1);
});

await test("applyAutomation() with nothing to change makes no database call at all", async () => {
  const id = await insertShipment(db1);
  const shipment = await asShipment(db1, id);
  let calls = 0;
  const spy = {
    rpc: async () => {
      calls += 1;
      return { data: {}, error: null };
    },
  } as unknown as Db;
  const r = await applyAutomation(
    shipment,
    {
      status: "Booked",
      monitoring_state: "Active Monitoring",
      reason: "x",
      source: "system",
      statusChanged: false,
      monitoringChanged: false,
    },
    spy,
  );
  assert.equal(r.outcome, "noop");
  assert.equal(calls, 0);
});

await test("applyAutomation() surfaces a database failure as a thrown error (never a silent partial write)", async () => {
  const id = await insertShipment(db1, { pendingStatus: "Departed", pendingSince: T0 });
  const shipment = await asShipment(db1, id);
  await db1.exec(`CREATE OR REPLACE FUNCTION public.t_fail_event2() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$;
                  CREATE TRIGGER t_fail_event2 BEFORE INSERT ON public.shipment_events FOR EACH ROW EXECUTE FUNCTION public.t_fail_event2();`);
  await assert.rejects(
    applyAutomation(
      shipment,
      {
        status: "Departed",
        monitoring_state: "Active Monitoring",
        reason: "r",
        source: "ais",
        statusChanged: true,
        monitoringChanged: false,
        pending: { status: null, since: null },
        evidenceAt: T0,
      },
      pgliteDb(db1),
    ),
    /boom/,
  );
  assert.equal((await getShipment(db1, id))["status"], "Booked");
  await db1.exec("DROP TRIGGER t_fail_event2 ON public.shipment_events");
});

await test("applyManualStatusChange() / resumeAutomation() (TypeScript) -> real SQL", async () => {
  const id = await insertShipment(db1, { status: "Arrived", actualArrival: T1 });
  const r = await applyManualStatusChange(
    {
      shipmentId: id,
      newStatus: "In Transit",
      eventType: "status_override",
      reason: "wrong",
      alertMessage: "manual",
    },
    pgliteDb(db1),
  );
  assert.equal(r.outcome, "applied");
  assert.equal(r.backward, true);
  assert.ok(r.holdUntil);
  const conflict = await applyManualStatusChange(
    {
      shipmentId: id,
      newStatus: "Approaching Destination",
      expectedStatus: "Booked",
      eventType: "status_manual",
    },
    pgliteDb(db1),
  );
  assert.equal(conflict.outcome, "conflict");
  assert.equal(await resumeAutomation(id, pgliteDb(db1)), "applied");
  assert.equal(await resumeAutomation(id, pgliteDb(db1)), "noop");
});

// ================================================== parity: emulation == SQL ====

type Step =
  | { kind: "auto"; args: Record<string, unknown> }
  | { kind: "manual"; args: Record<string, unknown> }
  | { kind: "resume"; args: Record<string, unknown> }
  | { kind: "reset"; patch: Record<string, unknown> }
  | { kind: "raw"; patch: Record<string, unknown> };

const PID = "11111111-1111-1111-1111-111111111111";
const auto = (over: Record<string, unknown> = {}): Step => ({
  kind: "auto",
  args: { ...decision(PID), ...over },
});
const manual = (over: Record<string, unknown>): Step => ({
  kind: "manual",
  args: { p_shipment_id: PID, ...over },
});

const SCENARIOS: Array<{ name: string; init: Record<string, unknown>; steps: Step[] }> = [
  {
    name: "forward advance with stamp",
    init: { pendingStatus: "Departed", pendingSince: T0 },
    steps: [auto()],
  },
  {
    name: "repeat of the same call",
    init: { pendingStatus: "Departed", pendingSince: T0 },
    steps: [auto(), auto()],
  },
  {
    name: "wrong expected status",
    init: { status: "In Transit", pendingStatus: "Departed", pendingSince: T0 },
    steps: [auto()],
  },
  {
    name: "duplicate key after reset",
    init: { pendingStatus: "Departed", pendingSince: T0 },
    steps: [
      auto(),
      {
        kind: "reset",
        patch: { status: "Booked", ais_pending_status: "Departed", ais_pending_since: T0 },
      },
      auto(),
    ],
  },
  {
    name: "pending-only update then stale pending",
    init: {},
    steps: [
      auto({
        p_new_status: "Booked",
        p_expected_pending_status: null,
        p_expected_pending_since: null,
        p_new_pending_status: "Departed",
        p_new_pending_since: T0,
        p_status_dedupe_key: null,
        p_stamp_actual_departure: null,
      }),
      auto({
        p_new_status: "Booked",
        p_expected_pending_status: null,
        p_expected_pending_since: null,
        p_new_pending_status: "Departed",
        p_new_pending_since: T1,
        p_status_dedupe_key: null,
        p_stamp_actual_departure: null,
      }),
    ],
  },
  {
    name: "monitoring-only change",
    init: { monitoring: "Scheduled" },
    steps: [
      auto({
        p_new_status: "Booked",
        p_update_pending: false,
        p_expected_monitoring_state: "Scheduled",
        p_new_monitoring_state: "Active Monitoring",
        p_status_dedupe_key: null,
        p_stamp_actual_departure: null,
        p_monitoring_reason: "window opened",
      }),
    ],
  },
  {
    name: "held (hold in future)",
    init: { holdUntil: inAnHour(), pendingStatus: "Departed", pendingSince: T0 },
    steps: [auto()],
  },
  {
    name: "hold expired",
    init: { holdUntil: anHourAgo(), pendingStatus: "Departed", pendingSince: T0 },
    steps: [auto()],
  },
  {
    name: "backward automation rejected",
    init: { status: "In Transit" },
    steps: [
      auto({
        p_expected_status: "In Transit",
        p_new_status: "Booked",
        p_update_pending: false,
        p_status_dedupe_key: null,
        p_stamp_actual_departure: null,
      }),
    ],
  },
  {
    name: "legacy status rejected",
    init: { status: "Delivered" },
    steps: [
      auto({
        p_expected_status: "Delivered",
        p_new_status: "Arrived",
        p_update_pending: false,
        p_status_dedupe_key: null,
        p_stamp_actual_departure: null,
      }),
    ],
  },
  {
    name: "stamp does not overwrite recorded value",
    init: {
      pendingStatus: "Departed",
      pendingSince: T0,
      actualDeparture: "2026-09-20T08:30:00.000Z",
    },
    steps: [auto()],
  },
  {
    name: "manual backward correction clears milestones + holds",
    init: { status: "Arrived", actualDeparture: T0, actualArrival: T1 },
    steps: [
      manual({
        p_new_status: "Booked",
        p_event_type: "status_override",
        p_reason: "fix",
        p_alert_message: "m",
      }),
    ],
  },
  {
    name: "manual forward advance",
    init: { pendingStatus: "Departed", pendingSince: T0 },
    steps: [
      manual({
        p_new_status: "Departed",
        p_expected_status: "Booked",
        p_event_type: "status_manual",
      }),
    ],
  },
  {
    name: "manual advance conflict",
    init: { status: "In Transit" },
    steps: [
      manual({
        p_new_status: "Departed",
        p_expected_status: "Booked",
        p_event_type: "status_manual",
      }),
    ],
  },
  { name: "manual noop", init: {}, steps: [manual({ p_new_status: "Booked" })] },
  {
    name: "correction then in-flight candidate",
    init: { status: "Approaching Destination", pendingStatus: "Arrived", pendingSince: T0 },
    steps: [
      auto({
        p_expected_status: "Approaching Destination",
        p_new_status: "Arrived",
        p_expected_pending_status: "Arrived",
        p_status_dedupe_key: "k1",
        p_stamp_actual_departure: null,
        p_stamp_actual_arrival: T0,
      }),
      {
        kind: "reset",
        patch: {
          status: "Approaching Destination",
          ais_pending_status: "Arrived",
          ais_pending_since: T0,
          actual_arrival: null,
        },
      },
      manual({ p_new_status: "In Transit", p_event_type: "status_override" }),
      auto({
        p_expected_status: "Approaching Destination",
        p_new_status: "Arrived",
        p_expected_pending_status: "Arrived",
        p_status_dedupe_key: "k2",
        p_stamp_actual_departure: null,
      }),
    ],
  },
  {
    name: "resume",
    init: { holdUntil: inAnHour(), pendingStatus: "Departed", pendingSince: T0 },
    steps: [{ kind: "resume", args: { p_shipment_id: PID } }, auto()],
  },
  {
    name: "evidence boundary: a candidate observed before the hold ended is refused, one after is accepted",
    init: { holdUntil: anHourAgo() },
    steps: [
      auto({
        p_new_status: "Booked",
        p_expected_pending_status: null,
        p_expected_pending_since: null,
        p_new_pending_status: "Departed",
        p_new_pending_since: new Date(Date.now() - 2 * 3_600_000).toISOString(),
        p_status_dedupe_key: null,
        p_stamp_actual_departure: null,
      }),
      auto({
        p_new_status: "Booked",
        p_expected_pending_status: null,
        p_expected_pending_since: null,
        p_new_pending_status: "Departed",
        p_new_pending_since: new Date(Date.now() - 30 * 60_000).toISOString(),
        p_status_dedupe_key: null,
        p_stamp_actual_departure: null,
      }),
    ],
  },
  {
    name: "resume ends the hold, then the boundary blocks older evidence",
    init: { holdUntil: inAnHour() },
    steps: [
      { kind: "resume", args: { p_shipment_id: PID } },
      { kind: "resume", args: { p_shipment_id: PID } },
      auto({
        p_new_status: "Booked",
        p_expected_pending_status: null,
        p_expected_pending_since: null,
        p_new_pending_status: "Departed",
        p_new_pending_since: new Date(Date.now() - 60_000).toISOString(),
        p_status_dedupe_key: null,
        p_stamp_actual_departure: null,
      }),
    ],
  },
  {
    name: "resume with an expired hold is a no-op",
    init: { holdUntil: anHourAgo() },
    steps: [{ kind: "resume", args: { p_shipment_id: PID } }],
  },
  {
    name: "raw input change voids pending",
    init: { pendingStatus: "Departed", pendingSince: T0 },
    steps: [{ kind: "raw", patch: { vessel_mmsi: "123456789" } }, auto()],
  },
  {
    name: "raw backward status sets hold",
    init: { status: "In Transit", pendingStatus: "Approaching Destination", pendingSince: T0 },
    steps: [
      { kind: "raw", patch: { status: "Booked" } },
      auto({
        p_expected_status: "Booked",
        p_new_status: "Departed",
        p_expected_pending_status: null,
        p_expected_pending_since: null,
      }),
    ],
  },
];

const summarise = (o: Record<string, unknown>) => ({
  outcome: o["outcome"],
  status_changed: o["status_changed"] ?? null,
  monitoring_changed: o["monitoring_changed"] ?? null,
  pending_changed: o["pending_changed"] ?? null,
  backward: o["backward"] ?? null,
  cleared_dep: o["cleared_actual_departure"] ?? null,
  cleared_arr: o["cleared_actual_arrival"] ?? null,
});
const finalState = (s: Record<string, unknown>) => ({
  status: s["status"],
  monitoring_state: s["monitoring_state"],
  pending: [s["ais_pending_status"] ?? null, iso(s["ais_pending_since"])],
  hold: s["automation_hold_until"] != null,
  actual_departure: iso(s["actual_departure"]),
  actual_arrival: iso(s["actual_arrival"]),
  mmsi: s["vessel_mmsi"] ?? null,
});

for (const sc of SCENARIOS) {
  await test(`parity — ${sc.name}: in-memory emulation and real SQL agree on every outcome, the final state and the history written`, async () => {
    // real SQL
    const sqlDb = await freshDb();
    await sqlDb.query(
      `INSERT INTO public.shipments (id, client_name, origin, destination, status, monitoring_state, planned_etd, ais_pending_status, ais_pending_since, actual_departure, actual_arrival, automation_hold_until)
      VALUES ($1,'T','A','B',$2::public.shipment_status,$3,now() - interval '1 day',$4::public.shipment_status,$5::timestamptz,$6::timestamptz,$7::timestamptz,$8::timestamptz)`,
      [
        PID,
        sc.init["status"] ?? "Booked",
        sc.init["monitoring"] ?? "Active Monitoring",
        sc.init["pendingStatus"] ?? null,
        sc.init["pendingSince"] ?? null,
        sc.init["actualDeparture"] ?? null,
        sc.init["actualArrival"] ?? null,
        sc.init["holdUntil"] ?? null,
      ],
    );
    // emulation
    const fake = makeFakeDb({
      shipments: [
        {
          id: PID,
          status: sc.init["status"] ?? "Booked",
          monitoring_state: sc.init["monitoring"] ?? "Active Monitoring",
          ais_pending_status: sc.init["pendingStatus"] ?? null,
          ais_pending_since: sc.init["pendingSince"] ?? null,
          actual_departure: sc.init["actualDeparture"] ?? null,
          actual_arrival: sc.init["actualArrival"] ?? null,
          automation_hold_until: sc.init["holdUntil"] ?? null,
          vessel_mmsi: null,
          planned_etd: new Date(Date.now() - 86_400_000).toISOString(),
        } as Row,
      ],
    });
    const fn = {
      auto: "apply_automation_decision",
      manual: "apply_manual_status_change",
      resume: "resume_shipment_automation",
    } as const;

    for (const step of sc.steps) {
      if (step.kind === "reset") {
        await sqlDb.exec("BEGIN");
        await sqlDb.exec("SELECT set_config('whitewind.transition_source','automation',true)");
        const sets = Object.keys(step.patch)
          .map((k, i) => `${k} = $${i + 2}`)
          .join(", ");
        await sqlDb.query(`UPDATE public.shipments SET ${sets} WHERE id = $1`, [
          PID,
          ...Object.values(step.patch),
        ]);
        await sqlDb.exec("COMMIT");
        Object.assign(fake.tables["shipments"]![0]!, step.patch);
      } else if (step.kind === "raw") {
        const sets = Object.keys(step.patch)
          .map((k, i) => `${k} = $${i + 2}${k === "status" ? "::public.shipment_status" : ""}`)
          .join(", ");
        await sqlDb.query(`UPDATE public.shipments SET ${sets} WHERE id = $1`, [
          PID,
          ...Object.values(step.patch),
        ]);
        await (
          fake as unknown as {
            from: (t: string) => {
              update: (p: Row) => { eq: (c: string, v: string) => Promise<unknown> };
            };
          }
        )
          .from("shipments")
          .update(step.patch)
          .eq("id", PID);
      } else {
        const a = await callFn(sqlDb, fn[step.kind], step.args);
        const b = (
          await (fake as unknown as { rpc: (f: string, a: Row) => Promise<{ data: unknown }> }).rpc(
            fn[step.kind],
            step.args,
          )
        ).data as Record<string, unknown>;
        assert.deepEqual(summarise(b), summarise(a), `step ${step.kind}: emulation vs SQL outcome`);
      }
    }
    assert.deepEqual(
      finalState(fake.tables["shipments"]![0]!),
      finalState(await getShipment(sqlDb, PID)),
      "final shipment state",
    );
    const sqlEvents = (
      await sqlDb.query<Record<string, unknown>>(
        `SELECT event_type, from_value, to_value, source, automated, actor, dedupe_key, reason FROM public.shipment_events ORDER BY created_at, event_type`,
      )
    ).rows;
    const fakeEvents = fake.tables["shipment_events"]!.map((e) => ({
      event_type: e["event_type"],
      from_value: e["from_value"] ?? null,
      to_value: e["to_value"] ?? null,
      source: e["source"],
      automated: e["automated"],
      actor: e["actor"] ?? null,
      dedupe_key: e["dedupe_key"] ?? null,
      reason: e["reason"] ?? null,
    }));
    const norm = (xs: Array<Record<string, unknown>>) =>
      xs.map((e) => JSON.stringify(e, Object.keys(e).sort())).sort();
    assert.deepEqual(
      norm(fakeEvents),
      norm(
        sqlEvents.map((e) => ({
          ...e,
          from_value: e["from_value"] ?? null,
          to_value: e["to_value"] ?? null,
          actor: e["actor"] ?? null,
          dedupe_key: e["dedupe_key"] ?? null,
          reason: e["reason"] ?? null,
        })),
      ),
      "history written",
    );
    assert.equal(
      fake.tables["alerts"]!.length,
      (await sqlDb.query(`SELECT 1 FROM public.alerts`)).rows.length,
      "alerts written",
    );
    await sqlDb.close();
  });
}

// ============================================================ privileges ====

const AUTO_FN = "apply_automation_decision";
const MANUAL_FN = "apply_manual_status_change";
const RESUME_FN = "resume_shipment_automation";

async function canExecute(db: PGlite, role: string, fn: string): Promise<boolean> {
  const r = await db.query<{ ok: boolean }>(
    `SELECT has_function_privilege($1, p.oid, 'EXECUTE') AS ok FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $2`,
    [role, fn],
  );
  assert.equal(r.rows.length, 1, `${fn} exists exactly once`);
  return r.rows[0]!.ok;
}

async function asRole<T>(db: PGlite, role: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec("RESET ROLE");
  }
}

await test("PRIVILEGES: apply_automation_decision is server-only — service_role yes; anon, authenticated and PUBLIC no", async () => {
  assert.equal(await canExecute(db1, "service_role", AUTO_FN), true);
  assert.equal(await canExecute(db1, "anon", AUTO_FN), false);
  assert.equal(await canExecute(db1, "authenticated", AUTO_FN), false);
  const acl = await db1.query<{ acl: string | null }>(
    `SELECT proacl::text AS acl FROM pg_proc WHERE proname = $1 AND pronamespace = 'public'::regnamespace`,
    [AUTO_FN],
  );
  assert.doesNotMatch(String(acl.rows[0]!.acl), /(^\{|,)=X\//, "PUBLIC holds no EXECUTE");
});

await test("PRIVILEGES: the operator functions stay callable by anon/authenticated/service_role, and not by PUBLIC", async () => {
  for (const fn of [MANUAL_FN, RESUME_FN]) {
    for (const role of ["anon", "authenticated", "service_role"]) {
      assert.equal(await canExecute(db1, role, fn), true, `${role} can execute ${fn}`);
    }
    const acl = await db1.query<{ acl: string | null }>(
      `SELECT proacl::text AS acl FROM pg_proc WHERE proname = $1 AND pronamespace = 'public'::regnamespace`,
      [fn],
    );
    assert.doesNotMatch(
      String(acl.rows[0]!.acl),
      /(^\{|,)=X\//,
      `PUBLIC holds no EXECUTE on ${fn}`,
    );
  }
});

await test("PRIVILEGES: the guard trigger function is not executable by the API roles, yet the trigger still fires for them", async () => {
  for (const role of ["anon", "authenticated"]) {
    assert.equal(await canExecute(db1, role, "shipments_guard_automation_state"), false);
  }
  const id = await insertShipment(db1, {
    status: "Arrived",
    pendingStatus: "Arrived",
    pendingSince: T0,
  });
  await asRole(db1, "anon", async () => {
    await db1.query(`UPDATE public.shipments SET status = 'In Transit' WHERE id = $1`, [id]);
  });
  const s = await getShipment(db1, id);
  assert.equal(s["ais_pending_status"], null, "the guard trigger ran for an anon writer");
  assert.ok(s["automation_hold_until"], "and put automation on hold after the backward change");
});

await test("PRIVILEGES: anon calling apply_automation_decision is refused, and nothing is written", async () => {
  const id = await insertShipment(db1, { pendingStatus: "Departed", pendingSince: T0 });
  for (const role of ["anon", "authenticated"]) {
    await asRole(db1, role, async () => {
      await assert.rejects(
        callFn(db1, AUTO_FN, decision(id)),
        /permission denied for function apply_automation_decision/,
      );
    });
  }
  const s = await getShipment(db1, id);
  assert.equal(s["status"], "Booked");
  assert.equal(await count(db1, "shipment_events", id), 0);
  assert.equal(await count(db1, "alerts", id), 0);
  // ...while the server role is unaffected.
  await asRole(db1, "service_role", async () => {
    assert.equal((await callFn(db1, AUTO_FN, decision(id)))["outcome"], "applied");
  });
});

await test("PRIVILEGES: the operator path works end to end as anon (correction -> hold -> resume), under RLS", async () => {
  const id = await insertShipment(db1, { status: "Arrived", actualArrival: T1 });
  await asRole(db1, "anon", async () => {
    const r = await callFn(db1, MANUAL_FN, {
      p_shipment_id: id,
      p_new_status: "In Transit",
      p_reason: "test",
      p_alert_message: "m",
    });
    assert.equal(r["outcome"], "applied");
    assert.equal((await callFn(db1, RESUME_FN, { p_shipment_id: id }))["outcome"], "applied");
  });
  const s = await getShipment(db1, id);
  assert.equal(s["status"], "In Transit");
  assert.equal(await count(db1, "shipment_events", id), 2);
});

await test("PRIVILEGES: the functions are SECURITY INVOKER with a pinned search_path — they run with the caller's rights, not the owner's", async () => {
  const r = await db1.query<{ proname: string; secdef: boolean; cfg: string | null }>(
    `SELECT proname, prosecdef AS secdef, proconfig::text AS cfg FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
        AND proname IN ('${AUTO_FN}','${MANUAL_FN}','${RESUME_FN}','shipments_guard_automation_state','automation_hold_hours')`,
  );
  assert.equal(r.rows.length, 5);
  for (const row of r.rows) {
    assert.equal(row.secdef, false, `${row.proname} is SECURITY INVOKER`);
    assert.match(String(row.cfg), /search_path=public, pg_temp/, `${row.proname} pins search_path`);
  }
});

await test("PRIVILEGES: a caller-controlled argument cannot reach another shipment — every write is keyed to the shipment id argument", async () => {
  const a = await insertShipment(db1, {
    status: "Arrived",
    actualArrival: T1,
    holdUntil: inAnHour(),
  });
  const b = await insertShipment(db1, {
    status: "Arrived",
    actualArrival: T1,
    holdUntil: inAnHour(),
    pendingStatus: "Arrived",
    pendingSince: T0,
  });
  const before = await getShipment(db1, b);
  const beforeEvents = await count(db1, "shipment_events", b);
  // Hostile-looking text in every free-text argument, targeting A only.
  const evil = `x'); UPDATE public.shipments SET status='Booked' WHERE ('1'='1`;
  await asRole(db1, "anon", async () => {
    await callFn(db1, MANUAL_FN, {
      p_shipment_id: a,
      p_new_status: "In Transit",
      p_reason: evil,
      p_actor: evil,
      p_alert_message: evil,
      p_event_type: evil,
    });
    await callFn(db1, RESUME_FN, { p_shipment_id: a, p_actor: evil });
  });
  const after = await getShipment(db1, b);
  assert.deepEqual(after, before, "the other shipment is byte-for-byte unchanged");
  assert.equal(await count(db1, "shipment_events", b), beforeEvents);
  assert.equal(await count(db1, "alerts", b), 0);
  assert.equal((await getShipment(db1, a))["status"], "In Transit");
});

await db1.close();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
