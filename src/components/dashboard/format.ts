import type { VesselPosition } from "@/lib/api";
import { isAisFresh, type VesselCondition } from "@/lib/aisAutomation";

/** Formatting and derivation helpers behind the dashboard's glyphs. */

const DAY = 86_400_000;
const HOUR = 3_600_000;

export type SignalState = "live" | "stale" | "none";

export type Signal = {
  state: SignalState;
  /** 0 to 4 bars: 4 under an hour old, 3 under six hours, 2 within the
   * 24-hour freshness window, 1 once stale, 0 with no position at all. */
  bars: number;
  /** Compact age of the last fix ("3m", "5h", "4d"), or null. */
  age: string | null;
};

export function signalOf(position: VesselPosition | null, now: number | null): Signal {
  if (!position || now == null) return { state: "none", bars: 0, age: null };
  const ts = position.position_timestamp ?? position.received_at;
  const age = ago(ts, now);
  if (!isAisFresh(position, now)) return { state: "stale", bars: 1, age };
  const hours = (now - new Date(ts).getTime()) / HOUR;
  return { state: "live", bars: hours < 1 ? 4 : hours < 6 ? 3 : 2, age };
}

/** What the vessel is doing, in words, when the signal supports saying so. */
export function vesselReading(
  condition: VesselCondition["kind"] | null,
  position: VesselPosition | null,
  hasMmsi: boolean,
  signal: Signal,
): { text: string; tone: string; moving: boolean } {
  if (!hasMmsi) return { text: "No MMSI", tone: "text-ink-3", moving: false };
  if (signal.state === "none") return { text: "No signal", tone: "text-ink-3", moving: false };
  if (signal.state === "stale") return { text: "Stale", tone: "text-ink-3", moving: false };
  if (condition === "underway") {
    return {
      text: position?.sog != null ? `${position.sog.toFixed(1)} kn` : "Under way",
      tone: "text-signal",
      moving: true,
    };
  }
  if (condition === "stopped") return { text: "Stopped", tone: "text-caution-ink", moving: false };
  return { text: "Reporting", tone: "text-ink-2", moving: false };
}

export function formatCoordinates(lat: number, lon: number) {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(2)}°${ns} ${Math.abs(lon).toFixed(2)}°${ew}`;
}

/** Compact age: "12m", "5h", "3d". */
export function ago(iso: string, now: number) {
  const diff = Math.max(0, now - new Date(iso).getTime());
  if (diff < HOUR) return `${Math.max(1, Math.round(diff / 60_000))}m`;
  if (diff < 2 * DAY) return `${Math.round(diff / HOUR)}h`;
  return `${Math.round(diff / DAY)}d`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "30 Sep", with the year only when it isn't the current one. */
export function shortDate(iso: string, now: number | null) {
  const d = new Date(iso);
  const sameYear = now == null || new Date(now).getFullYear() === d.getFullYear();
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return sameYear ? base : `${base} ${d.getFullYear()}`;
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
