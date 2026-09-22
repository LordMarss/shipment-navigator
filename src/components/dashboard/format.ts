import type { VesselPosition } from "@/lib/api";
import { isAisFresh, type VesselCondition } from "@/lib/aisAutomation";

/** Formatting and derivation helpers behind the dashboard's glyphs. */

const DAY = 86_400_000;
const HOUR = 3_600_000;

export type SignalState = "live" | "stale" | "none";

export function signalState(position: VesselPosition | null, now: number | null): SignalState {
  if (!position || now == null) return "none";
  return isAisFresh(position, now) ? "live" : "stale";
}

export function vesselReading(
  condition: VesselCondition["kind"] | null,
  position: VesselPosition | null,
  hasMmsi: boolean,
  state: SignalState,
  now: number | null,
): { text: string; tone: string } {
  if (!hasMmsi) return { text: "No MMSI", tone: "text-muted-foreground" };
  if (state === "none") return { text: "No position", tone: "text-muted-foreground" };
  if (state === "stale" && position && now != null) {
    const ts = position.position_timestamp ?? position.received_at;
    return { text: `Last fix ${ago(ts, now)} ago`, tone: "text-muted-foreground" };
  }
  if (condition === "underway") {
    return {
      text: position?.sog != null ? `${position.sog.toFixed(1)} kn` : "Under way",
      tone: "text-primary-deep",
    };
  }
  if (condition === "stopped") return { text: "Stopped", tone: "text-warning" };
  return { text: "Reporting", tone: "text-muted-foreground" };
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
