import type { Shipment, VesselPosition } from "@/lib/api";
import type { VesselCondition } from "@/lib/aisAutomation";
import {
  formatCoordinates,
  shortDate,
  targetOf,
  tCount,
  voyageOf,
} from "@/components/maritime/format";
import { AisTarget } from "@/components/maritime/marks";

const KM_PER_NM = 1.852;

/**
 * One voyage, plotted large: origin and destination as chart annotations,
 * the track made good solid and the planned track dashed, the vessel as an
 * AIS target. When the page can measure progress (structured ports and a
 * live position) the target sits at the measured great-circle fraction and
 * the distance to go is given in nautical miles; otherwise it falls back to
 * the phase-and-schedule estimate and says so.
 */
export function VoyagePlot({
  shipment: s,
  position,
  condition,
  measured,
  now,
}: {
  shipment: Shipment;
  position: VesselPosition | null;
  condition: VesselCondition["kind"] | null;
  measured: { pct: number; totalKm: number; remainingKm: number } | null;
  now: number | null;
}) {
  const voyage = voyageOf(s, now);
  const target = targetOf(position, condition, Boolean(s.vessel_mmsi), now);
  const pos = voyage.arrived ? 1 : measured && s.actual_departure ? measured.pct : voyage.pos;
  const basis = voyage.arrived
    ? "Arrived"
    : measured && s.actual_departure
      ? `By position: ${Math.round(measured.pct * 100)}%, ${Math.round(measured.remainingKm / KM_PER_NM).toLocaleString()} nm to go`
      : voyage.day
        ? `By schedule: day ${voyage.day.elapsed} of ${voyage.day.total}`
        : pos == null
          ? "Alongside, not yet sailed"
          : "Position estimated from phase";
  const departOverdue =
    !s.actual_departure &&
    s.planned_etd != null &&
    now != null &&
    new Date(s.planned_etd).getTime() < now;
  const eta = s.eta && now != null ? tCount(s.eta, now) : null;
  const moving = target.state === "active";

  const label = `${s.origin} to ${s.destination}. ${basis}.`;

  return (
    <section aria-label="Voyage plot" className="border-b-2 border-sea-ink pb-5">
      <div className="grid grid-cols-2 gap-6">
        <div className="min-w-0">
          <p className="chart-label text-sea-ink-3">Origin</p>
          <p className="mt-1 truncate text-[19px] font-medium tracking-[-0.01em] text-sea-ink">
            {s.origin}
          </p>
          <p
            className={`telemetry mt-1 text-[11.5px] ${departOverdue ? "font-medium text-sea-red" : "text-sea-ink-3"}`}
          >
            {s.actual_departure
              ? `Sailed ${shortDate(s.actual_departure, now)}`
              : s.planned_etd
                ? `ETD ${shortDate(s.planned_etd, now)}${departOverdue && now != null ? `  ${tCount(s.planned_etd, now).label}` : ""}`
                : "No ETD"}
          </p>
        </div>
        <div className="min-w-0 text-right">
          <p className="chart-label text-sea-ink-3">Destination</p>
          <p className="mt-1 truncate text-[19px] font-medium tracking-[-0.01em] text-sea-ink">
            {s.destination}
          </p>
          <p className="telemetry mt-1 text-[11.5px] text-sea-ink-3">
            {voyage.arrived ? (
              <span className="text-sea-green">Arrived</span>
            ) : s.eta ? (
              <>
                ETA {shortDate(s.eta, now)}
                {eta ? (
                  <span className={eta.past ? "ml-2 font-medium text-sea-red" : "ml-2"}>
                    {eta.label}
                  </span>
                ) : null}
              </>
            ) : (
              "No ETA"
            )}
          </p>
        </div>
      </div>

      <div className="relative mx-[6px] mt-5 h-[18px]" role="img" aria-label={label}>
        <span className="absolute inset-x-0 top-1/2 -translate-y-1/2 border-t border-dashed border-sea-ink-4" />
        {/* scale ticks, like the divisions on a chart's distance scale */}
        {[0.25, 0.5, 0.75].map((t) => (
          <span
            key={t}
            aria-hidden
            className="absolute top-[4px] h-[10px] w-px bg-sea-rule"
            style={{ left: `${t * 100}%` }}
          />
        ))}
        {pos != null && pos > 0 ? (
          <span
            className={`absolute left-0 top-1/2 h-[2px] -translate-y-1/2 ${voyage.arrived ? "bg-sea-ink-3" : "bg-sea-move"}`}
            style={{ width: `${pos * 100}%` }}
          />
        ) : null}
        <span className="absolute left-0 top-1/2 size-[11px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-sea-ink-2 bg-sea-paper" />
        <span
          className={`absolute left-full top-1/2 size-[11px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 ${
            voyage.arrived ? "border-sea-green bg-sea-green" : "border-sea-ink bg-sea-paper"
          }`}
        />
        {!voyage.arrived && target.state !== "none" ? (
          <span
            className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${(pos ?? 0) * 100}%` }}
          >
            <AisTarget state={target.state} stopped={target.stopped} size={16} />
          </span>
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1.5 text-[12px]">
        <span className="text-sea-ink-2">{basis}</span>
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {s.vessel_name ? <span className="text-sea-ink">{s.vessel_name}</span> : null}
          <span
            className={`telemetry text-[11.5px] ${
              moving ? "text-sea-move" : target.stopped ? "text-sea-amber-ink" : "text-sea-ink-3"
            }`}
          >
            {target.reading}
            {target.cog != null && target.state !== "none" && target.state !== "lost"
              ? `  COG ${String(Math.round(target.cog)).padStart(3, "0")}°`
              : ""}
          </span>
          {position && target.state !== "none" ? (
            <span className="telemetry text-[11px] text-sea-ink-3">
              {formatCoordinates(position.latitude, position.longitude)}
              {target.age ? `  fix ${target.age} ago` : ""}
            </span>
          ) : null}
        </span>
      </div>
    </section>
  );
}
