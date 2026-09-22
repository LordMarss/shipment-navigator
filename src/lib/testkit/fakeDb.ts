/**
 * A small in-memory stand-in for the Supabase client, covering exactly the
 * query shapes the automation code uses, plus an EMULATION of the three
 * Phase 2 database functions (apply_automation_decision,
 * apply_manual_status_change, resume_shipment_automation).
 *
 * The emulation exists so the webhook / sweep / API plumbing can be tested
 * quickly and deterministically without a database. It is NOT trusted on its
 * own: `transitions.db.test.ts` runs the same scenarios through the emulation
 * and through the real SQL (applied to a real Postgres engine) and requires
 * identical outcomes and identical resulting state, so the two cannot drift.
 *
 * Every awaited operation yields to the microtask queue, so two flows started
 * together (Promise.all) genuinely interleave at each await — both can read
 * the same snapshot before either writes — while the RPC bodies, like a
 * database function under a row lock, run to completion without interleaving.
 */
import type { Db } from "@/lib/api";

export type Row = Record<string, unknown>;
type Filter = (r: Row) => boolean;

const ACTIVE = [
  "Scheduled",
  "Booked",
  "Departed",
  "In Transit",
  "Approaching Destination",
  "Arrived",
];
const rankOf = (s: unknown): number | null => {
  const i = ACTIVE.indexOf(String(s));
  return i === -1 ? null : i + 1;
};
const tsEq = (a: unknown, b: unknown) => {
  if (a == null || b == null) return a == null && b == null;
  return new Date(a as string).getTime() === new Date(b as string).getTime();
};

export type FakeDbOptions = {
  shipments?: Row[];
  vessel_positions?: Row[];
  ports?: Row[];
  app_settings?: Row[];
  /** Milliseconds "now" for hold checks inside the emulated functions. */
  now?: () => number;
  /** Default hold length (hours) after a backward manual correction. */
  holdHours?: number;
};

export type FakeDb = Db & {
  tables: Record<string, Row[]>;
  /** Log of every write, in order — for asserting what was (not) written. */
  writes: Array<{ table: string; op: "insert" | "update"; row: Row }>;
  /** Make the next matching insert throw, to test rollback. */
  failInsert: (table: string, match?: (row: Row) => boolean) => void;
  /** Every rpc call made, with its outcome. */
  rpcCalls: Array<{ fn: string; args: Row; result: Row }>;
};

export function makeFakeDb(seed: FakeDbOptions = {}): FakeDb {
  const now = seed.now ?? (() => Date.now());
  const holdHours = seed.holdHours ?? 24;
  const tables: Record<string, Row[]> = {
    shipments: (seed.shipments ?? []).map((r) => ({ ...r })),
    vessel_positions: (seed.vessel_positions ?? []).map((r) => ({ ...r })),
    ports: (seed.ports ?? []).map((r) => ({ ...r })),
    app_settings: (seed.app_settings ?? []).map((r) => ({ ...r })),
    shipment_events: [],
    alerts: [],
  };
  const writes: FakeDb["writes"] = [];
  const rpcCalls: FakeDb["rpcCalls"] = [];
  let failing: { table: string; match?: ((row: Row) => boolean) | undefined } | null = null;
  const tick = () => Promise.resolve();
  const rows = (t: string) => (tables[t] ??= []);

  function insertRow(table: string, row: Row) {
    if (failing && failing.table === table && (!failing.match || failing.match(row))) {
      failing = null;
      throw new Error(`simulated ${table} insert failure`);
    }
    if (
      row["dedupe_key"] != null &&
      rows(table).some((r) => r["dedupe_key"] === row["dedupe_key"])
    ) {
      throw new Error(`duplicate key value violates unique constraint "${table}_dedupe_key_idx"`);
    }
    const stored = { id: `${table}-${rows(table).length + 1}`, ...row };
    rows(table).push(stored);
    writes.push({ table, op: "insert", row: stored });
    return stored;
  }

  /** Emulates shipments_guard_automation_state() for a plain UPDATE. */
  function applyShipmentPatch(r: Row, patch: Row, automation = false) {
    const before = { ...r };
    Object.assign(r, patch);
    const inputsChanged = [
      "vessel_mmsi",
      "origin_port_id",
      "destination_port_id",
      "planned_etd",
    ].some(
      (k) =>
        k in patch &&
        !(k === "planned_etd" ? tsEq(before[k], r[k]) : (before[k] ?? null) === (r[k] ?? null)),
    );
    if (inputsChanged) {
      r["ais_pending_status"] = null;
      r["ais_pending_since"] = null;
    }
    if (r["status"] !== before["status"] && !automation) {
      r["ais_pending_status"] = null;
      r["ais_pending_since"] = null;
      if (
        (rankOf(r["status"]) ?? 0) < (rankOf(before["status"]) ?? 0) &&
        !("automation_hold_until" in patch) &&
        holdHours > 0
      ) {
        r["automation_hold_until"] = new Date(now() + holdHours * 3_600_000).toISOString();
      }
    }
    writes.push({ table: "shipments", op: "update", row: { ...patch } });
  }

  function query(table: string, filters: Filter[] = []) {
    const run = () => rows(table).filter((r) => filters.every((f) => f(r)));
    const q = {
      eq: (c: string, v: unknown) => query(table, [...filters, (r) => r[c] === v]),
      neq: (c: string, v: unknown) => query(table, [...filters, (r) => r[c] !== v]),
      is: (c: string, v: unknown) => query(table, [...filters, (r) => (r[c] ?? null) === v]),
      in: (c: string, vs: unknown[]) => query(table, [...filters, (r) => vs.includes(r[c])]),
      maybeSingle: async () => {
        await tick();
        return { data: run()[0] ?? null, error: null };
      },
      then: (resolve: (v: { data: Row[]; error: null }) => void, reject: (e: unknown) => void) =>
        tick()
          .then(() => ({ data: run(), error: null }))
          .then(resolve, reject),
    };
    return q;
  }

  // ---- emulation of the database functions -------------------------------

  function applyAutomationDecision(a: Row): Row {
    const statusChanging = a["p_new_status"] !== a["p_expected_status"];
    const monitoringChanging = a["p_new_monitoring_state"] !== a["p_expected_monitoring_state"];
    const pendingChanging =
      a["p_update_pending"] === true &&
      ((a["p_new_pending_status"] ?? null) !== (a["p_expected_pending_status"] ?? null) ||
        !tsEq(a["p_new_pending_since"], a["p_expected_pending_since"]));
    if (!(statusChanging || monitoringChanging || pendingChanging)) return { outcome: "noop" };

    const v = rows("shipments").find((r) => r["id"] === a["p_shipment_id"]);
    if (!v) return { outcome: "not_found" };

    const hold = v["automation_hold_until"]
      ? new Date(v["automation_hold_until"] as string).getTime()
      : null;
    if ((statusChanging || pendingChanging) && hold !== null && hold > now())
      return { outcome: "held" };
    // The hold's end is also the evidence boundary: an observation at or before
    // it never starts a candidate.
    if (
      pendingChanging &&
      a["p_new_pending_since"] != null &&
      hold !== null &&
      new Date(a["p_new_pending_since"] as string).getTime() <= hold
    )
      return { outcome: "held", reason: "evidence_predates_hold" };

    if ((statusChanging || pendingChanging) && v["status"] !== a["p_expected_status"]) {
      return { outcome: "conflict", reason: "status_changed" };
    }
    if (
      pendingChanging &&
      ((v["ais_pending_status"] ?? null) !== (a["p_expected_pending_status"] ?? null) ||
        !tsEq(v["ais_pending_since"], a["p_expected_pending_since"]))
    ) {
      return { outcome: "conflict", reason: "pending_changed" };
    }
    if (statusChanging) {
      const from = rankOf(a["p_expected_status"]);
      const to = rankOf(a["p_new_status"]);
      if (from === null || to === null || to <= from)
        return { outcome: "rejected", reason: "not_a_forward_move" };
    }

    const monitoringApplied =
      monitoringChanging && v["monitoring_state"] === a["p_expected_monitoring_state"];
    const nowIso = new Date(now()).toISOString();

    if (statusChanging) {
      const key = (a["p_status_dedupe_key"] ?? null) as string | null;
      if (key !== null && rows("shipment_events").some((e) => e["dedupe_key"] === key))
        return { outcome: "duplicate" };

      // Build every write first and only then commit them — a failure part-way
      // (an insert that throws) must leave the shipment untouched, like a rolled-back transaction.
      const snapshot = JSON.parse(JSON.stringify(v)) as Row;
      const eventsBefore = rows("shipment_events").length;
      const alertsBefore = rows("alerts").length;
      const writesBefore = writes.length;
      try {
        applyShipmentPatch(
          v,
          {
            status: a["p_new_status"],
            ais_pending_status: null,
            ais_pending_since: null,
            ...(monitoringApplied ? { monitoring_state: a["p_new_monitoring_state"] } : {}),
            actual_departure: v["actual_departure"] ?? a["p_stamp_actual_departure"] ?? null,
            actual_arrival: v["actual_arrival"] ?? a["p_stamp_actual_arrival"] ?? null,
            last_synced_at: nowIso,
          },
          true,
        );
        insertRow("shipment_events", {
          shipment_id: a["p_shipment_id"],
          event_type: "status_auto",
          category: "status",
          field: "Status",
          from_value: snapshot["status"],
          to_value: a["p_new_status"],
          source: a["p_source"],
          automated: true,
          actor: a["p_actor"],
          reason: a["p_reason"] ?? null,
          occurred_at: (a["p_occurred_at"] as string | null) ?? nowIso,
          dedupe_key: key,
        });
        if (a["p_alert_message"] != null) {
          insertRow("alerts", {
            shipment_id: a["p_shipment_id"],
            message: a["p_alert_message"],
            from_status: snapshot["status"],
            to_status: a["p_new_status"],
            dedupe_key: key,
          });
        }
        if (monitoringApplied) {
          insertRow("shipment_events", {
            shipment_id: a["p_shipment_id"],
            event_type: "monitoring_auto",
            category: "monitoring",
            field: "Monitoring state",
            from_value: a["p_expected_monitoring_state"],
            to_value: a["p_new_monitoring_state"],
            source: "system",
            automated: true,
            actor: a["p_actor"],
            reason: (a["p_monitoring_reason"] ?? a["p_reason"] ?? null) as string | null,
            occurred_at: (a["p_occurred_at"] as string | null) ?? nowIso,
          });
        }
      } catch (e) {
        // roll back everything this call did
        for (const k of Object.keys(v)) delete v[k];
        Object.assign(v, snapshot);
        rows("shipment_events").length = eventsBefore;
        rows("alerts").length = alertsBefore;
        writes.length = writesBefore;
        throw e;
      }
    } else {
      applyShipmentPatch(
        v,
        {
          ...(monitoringApplied ? { monitoring_state: a["p_new_monitoring_state"] } : {}),
          ...(pendingChanging
            ? {
                ais_pending_status: a["p_new_pending_status"] ?? null,
                ais_pending_since: a["p_new_pending_since"] ?? null,
              }
            : {}),
          last_synced_at: nowIso,
        },
        true,
      );
      if (monitoringApplied) {
        insertRow("shipment_events", {
          shipment_id: a["p_shipment_id"],
          event_type: "monitoring_auto",
          category: "monitoring",
          field: "Monitoring state",
          from_value: a["p_expected_monitoring_state"],
          to_value: a["p_new_monitoring_state"],
          source: "system",
          automated: true,
          actor: a["p_actor"],
          reason: (a["p_monitoring_reason"] ?? a["p_reason"] ?? null) as string | null,
          occurred_at: (a["p_occurred_at"] as string | null) ?? nowIso,
        });
      }
    }
    return {
      outcome: "applied",
      status_changed: statusChanging,
      monitoring_changed: monitoringApplied,
      pending_changed: pendingChanging || statusChanging,
    };
  }

  function applyManualStatusChange(a: Row): Row {
    const v = rows("shipments").find((r) => r["id"] === a["p_shipment_id"]);
    if (!v) return { outcome: "not_found" };
    if (a["p_expected_status"] != null && v["status"] !== a["p_expected_status"])
      return { outcome: "conflict", reason: "status_changed" };
    if (v["status"] === a["p_new_status"]) return { outcome: "noop" };

    const oldRank = rankOf(v["status"]);
    const newRank = rankOf(a["p_new_status"]);
    const backward = newRank !== null && oldRank !== null && newRank < oldRank;
    const holdUntil =
      backward && holdHours > 0 ? new Date(now() + holdHours * 3_600_000).toISOString() : null;
    const clearDep = backward && (newRank as number) < 3 && v["actual_departure"] != null;
    const clearArr = backward && (newRank as number) < 6 && v["actual_arrival"] != null;
    let note = "";
    const fmt = (x: unknown) => new Date(x as string).toISOString().slice(0, 16) + "Z";
    if (clearDep) note += ` Cleared actual_departure (${fmt(v["actual_departure"])}).`;
    if (clearArr) note += ` Cleared actual_arrival (${fmt(v["actual_arrival"])}).`;
    const fromStatus = v["status"];

    applyShipmentPatch(
      v,
      {
        status: a["p_new_status"],
        ais_pending_status: null,
        ais_pending_since: null,
        ...(holdUntil ? { automation_hold_until: holdUntil } : {}),
        ...(clearDep ? { actual_departure: null } : {}),
        ...(clearArr ? { actual_arrival: null } : {}),
      },
      false,
    );
    const reason = `${(a["p_reason"] as string | null) ?? ""}${note}`.trim();
    insertRow("shipment_events", {
      shipment_id: a["p_shipment_id"],
      event_type: a["p_event_type"] ?? "status_override",
      category: "status",
      field: "Status",
      from_value: fromStatus,
      to_value: a["p_new_status"],
      source: "manual",
      automated: false,
      actor: a["p_actor"] ?? "Operator",
      reason: reason === "" ? null : reason,
    });
    if (a["p_alert_message"] != null) {
      insertRow("alerts", {
        shipment_id: a["p_shipment_id"],
        message: a["p_alert_message"],
        from_status: fromStatus,
        to_status: a["p_new_status"],
      });
    }
    return {
      outcome: "applied",
      backward,
      hold_until: holdUntil,
      cleared_actual_departure: clearDep,
      cleared_actual_arrival: clearArr,
    };
  }

  function resumeAutomation(a: Row): Row {
    const v = rows("shipments").find((r) => r["id"] === a["p_shipment_id"]);
    if (!v) return { outcome: "not_found" };
    const heldUntil = v["automation_hold_until"]
      ? new Date(v["automation_hold_until"] as string).getTime()
      : null;
    if (heldUntil === null || heldUntil <= now()) return { outcome: "noop" };
    // Ends the hold now; that instant stays as the evidence boundary.
    const boundary = new Date(now()).toISOString();
    v["automation_hold_until"] = boundary;
    v["ais_pending_status"] = null;
    v["ais_pending_since"] = null;
    writes.push({ table: "shipments", op: "update", row: { automation_hold_until: boundary } });
    insertRow("shipment_events", {
      shipment_id: a["p_shipment_id"],
      event_type: "automation_resumed",
      category: "event",
      field: "Automation hold",
      from_value: `Held until ${new Date(heldUntil).toISOString().slice(0, 16)}Z`,
      to_value: "Resumed",
      source: "manual",
      automated: false,
      actor: a["p_actor"] ?? "Operator",
      reason: "Automation resumed by operator",
    });
    return { outcome: "applied" };
  }

  const db = {
    tables,
    writes,
    rpcCalls,
    failInsert(table: string, match?: (row: Row) => boolean) {
      failing = { table, match };
    },
    async rpc(fn: string, args: Row) {
      await tick();
      let result: Row;
      try {
        if (fn === "apply_automation_decision") result = applyAutomationDecision(args);
        else if (fn === "apply_manual_status_change") result = applyManualStatusChange(args);
        else if (fn === "resume_shipment_automation") result = resumeAutomation(args);
        else throw new Error(`unknown rpc ${fn}`);
      } catch (e) {
        return { data: null, error: e instanceof Error ? e : new Error(String(e)) };
      }
      rpcCalls.push({ fn, args, result });
      return { data: result, error: null };
    },
    from(table: string) {
      return {
        select: (_cols: string) => query(table),
        update: (patch: Row) => {
          const apply = async (filters: Filter[]) => {
            await tick();
            for (const r of rows(table)) {
              if (!filters.every((f) => f(r))) continue;
              if (table === "shipments") applyShipmentPatch(r, patch, false);
              else {
                Object.assign(r, patch);
                writes.push({ table, op: "update", row: { ...patch } });
              }
            }
            return { error: null };
          };
          return {
            eq: (c: string, v: unknown) => apply([(r) => r[c] === v]),
            in: (c: string, vs: unknown[]) => apply([(r) => vs.includes(r[c])]),
          };
        },
        insert: async (obj: Row | Row[]) => {
          await tick();
          try {
            for (const o of Array.isArray(obj) ? obj : [obj]) insertRow(table, o);
          } catch (e) {
            return { error: e instanceof Error ? e : new Error(String(e)) };
          }
          return { error: null };
        },
      };
    },
  };
  return db as unknown as FakeDb;
}
