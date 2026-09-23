import type { Shipment, ShipmentStatus, VesselPosition } from "@/lib/api";
import { isAisFresh, type VesselCondition } from "@/lib/aisAutomation";
import type { HealthLevel } from "@/lib/lifecycle";

/** Formatting and derivation helpers behind the dashboard's marks. */

const DAY = 86_400_000;
const HOUR = 3_600_000;

/* ------------------------------------------------------------------ AIS --- */

/**
 * The vessel as an AIS target, following chart-display convention:
 *   active   fresh fix and under way: filled target
 *   idle     fresh fix, not moving (or not clearly): hollow target
 *   lost     a fix exists but is stale: hollow target, struck through
 *   none     no position (or no MMSI): no target drawn
 */
export type TargetState = "active" | "idle" | "lost" | "none";

export type Target = {
  state: TargetState;
  /** Compact age of the last fix ("3m", "5h", "4d"), or null. */
  age: string | null;
  /** Short reading for the board: "12.4 kn", "Stopped", "Lost 4d". */
  reading: string;
  /** True when AIS says the vessel is stopped (fresh fix, no way on). */
  stopped: boolean;
  sog: number | null;
  cog: number | null;
};

export function targetOf(
  position: VesselPosition | null,
  condition: VesselCondition["kind"] | null,
  hasMmsi: boolean,
  now: number | null,
): Target {
  const none = (reading: string): Target => ({
    state: "none",
    age: null,
    reading,
    stopped: false,
    sog: null,
    cog: null,
  });
  if (!hasMmsi) return none("No MMSI");
  if (!position || now == null) return none("No AIS");
  const ts = position.position_timestamp ?? position.received_at;
  const age = ago(ts, now);
  const base = { age, sog: position.sog, cog: position.cog };
  if (!isAisFresh(position, now))
    return { ...base, state: "lost", reading: `Lost ${age}`, stopped: false };
  if (condition === "underway") {
    return {
      ...base,
      state: "active",
      reading: position.sog != null ? `${position.sog.toFixed(1)} kn` : "Under way",
      stopped: false,
    };
  }
  if (condition === "stopped") return { ...base, state: "idle", reading: "Stopped", stopped: true };
  return { ...base, state: "idle", reading: "Reporting", stopped: false };
}

export function formatCoordinates(lat: number, lon: number) {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  const dm = (v: number) => {
    const a = Math.abs(v);
    const d = Math.floor(a);
    const m = (a - d) * 60;
    return `${d}°${m.toFixed(1).padStart(4, "0")}′`;
  };
  return `${dm(lat)}${ns} ${dm(lon)}${ew}`;
}

/* --------------------------------------------------------------- voyage --- */

/**
 * Where to plot the vessel on its passage line. The lifecycle phase sets a
 * band (departed near the origin, approaching near the destination); within
 * the band the position follows elapsed schedule time, actual departure to
 * current ETA. It is an estimate by schedule, never a position fix.
 */
const PHASE_BAND: Partial<Record<ShipmentStatus, [number, number]>> = {
  Departed: [0.03, 0.35],
  "In Transit": [0.08, 0.88],
  "Approaching Destination": [0.85, 0.98],
};

export type Voyage = {
  /** 0..1 along the line, or null while still alongside at origin. */
  pos: number | null;
  arrived: boolean;
  /** Day N of M by schedule, when departure and ETA are both known. */
  day: { elapsed: number; total: number } | null;
};

const ARRIVED = new Set<ShipmentStatus>(["Arrived", "At Port", "Cleared Customs", "Delivered"]);

export function voyageOf(s: Shipment, now: number | null): Voyage {
  if (ARRIVED.has(s.status) || s.actual_arrival) return { pos: 1, arrived: true, day: null };
  const band = PHASE_BAND[s.status];
  if (!band) return { pos: null, arrived: false, day: null };
  const [lo, hi] = band;
  if (s.actual_departure && s.eta && now != null) {
    const dep = new Date(s.actual_departure).getTime();
    const eta = new Date(s.eta).getTime();
    const p = eta > dep ? (now - dep) / (eta - dep) : 1;
    const total = Math.max(1, Math.round((eta - dep) / DAY));
    const elapsed = Math.min(total, Math.max(0, Math.round((now - dep) / DAY)));
    return { pos: Math.min(hi, Math.max(lo, p)), arrived: false, day: { elapsed, total } };
  }
  return { pos: (lo + hi) / 2, arrived: false, day: null };
}

/* ----------------------------------------------------------------- time --- */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Compact age: "12m", "5h", "3d". */
export function ago(iso: string, now: number) {
  const diff = Math.max(0, now - new Date(iso).getTime());
  if (diff < HOUR) return `${Math.max(1, Math.round(diff / 60_000))}m`;
  if (diff < 2 * DAY) return `${Math.round(diff / HOUR)}h`;
  return `${Math.round(diff / DAY)}d`;
}

/** "30 Sep", with the year only when it isn't the current one. */
export function shortDate(iso: string, now: number | null) {
  const d = new Date(iso);
  const sameYear = now == null || new Date(now).getFullYear() === d.getFullYear();
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return sameYear ? base : `${base} ${d.getFullYear()}`;
}

export function weekday(t: number) {
  return DAYS[new Date(t).getDay()]!;
}

export function monthName(t: number) {
  return MONTHS[new Date(t).getMonth()]!;
}

/** Local 24-hour clock, "14:05". */
export function clock(t: number) {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** UTC 24-hour clock, "18:05". */
export function utcClock(t: number) {
  const d = new Date(t);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** Signed offset to an event: T−8d before it, T+2d after it (hours inside
 * two days). The minus is a true minus sign, so the notation aligns in
 * tabular figures. */
export function tCount(iso: string, now: number) {
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  const value =
    abs < 2 * DAY ? `${Math.max(1, Math.round(abs / HOUR))}h` : `${Math.round(abs / DAY)}d`;
  return { label: `T${diff >= 0 ? "−" : "+"}${value}`, past: diff < 0 };
}

/* ------------------------------------------------------------ condition --- */

/** Bridge alert vocabulary: at risk or delayed is an alarm, attention a caution. */
export type ConditionLevel = "alarm" | "caution";

export function conditionOf(level: HealthLevel): ConditionLevel | null {
  if (level === "At Risk" || level === "Delayed") return "alarm";
  if (level === "Attention") return "caution";
  return null;
}
