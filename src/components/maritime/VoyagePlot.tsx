import type { Shipment, VesselPosition } from "@/lib/api";
import type { VesselCondition } from "@/lib/aisAutomation";
import {
  formatCoordinates,
  slipLabel,
  targetOf,
  tCount,
  utcClock,
  utcDayTime,
  voyageOf,
} from "@/components/maritime/format";
import { AisTarget, Bearing } from "@/components/maritime/marks";

const KM_PER_NM = 1.852;

/**
 * One voyage, plotted as a strip of chart: origin and destination as
 * annotated ports, a faint graticule, the track made good solid (blue only
 * while AIS confirms the vessel is under way) and the planned track
 * dotted, the vessel as its AIS target with its course, a line for the
 * present moment, and the passage divided into days by schedule. When the
 * page can measure progress (structured ports and a live position) the
 * target sits at the measured great-circle fraction and the distance to go
 * is given in nautical miles; otherwise it falls back to the schedule
 * estimate and says so.
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
  const byPosition = Boolean(measured && s.actual_departure && !voyage.arrived);
  const pos = voyage.arrived ? 1 : byPosition ? measured!.pct : voyage.pos;
  // Blue only for this voyage's own movement: once sailed, before arrival.
  const moving = target.state === "active" && Boolean(s.actual_departure) && !voyage.arrived;
  const departOverdue =
    !s.actual_departure &&
    s.planned_etd != null &&
    now != null &&
    new Date(s.planned_etd).getTime() < now;
  const eta = s.eta && now != null ? tCount(s.eta, now) : null;
  const arrivalOverdue = Boolean(eta?.past) && !voyage.arrived;
  const slip =
    s.planned_eta && s.eta
      ? Math.round((new Date(s.eta).getTime() - new Date(s.planned_eta).getTime()) / 3_600_000)
      : 0;

  const basis = voyage.arrived
    ? "Passage complete"
    : byPosition
      ? `By AIS position: ${Math.round(measured!.pct * 100)}% made good, ${Math.round(
          measured!.remainingKm / KM_PER_NM,
        ).toLocaleString()} NM to go of ${Math.round(measured!.totalKm / KM_PER_NM).toLocaleString()}`
      : voyage.day
        ? `By schedule: day ${voyage.day.elapsed} of ${voyage.day.total}. Link both ports to measure by position.`
        : pos == null
          ? "Alongside at origin, not yet sailed"
          : s.eta
            ? "Position estimated from phase"
            : "Position estimated from phase. Set an ETA and link both ports to measure it.";

  // Day divisions by schedule, labelled so no more than seven are named.
  const days = voyage.day?.total ?? 0;
  const step = days > 0 ? Math.max(1, Math.ceil(days / 7)) : 0;
  const ticks = days > 0 ? Array.from({ length: days + 1 }, (_, i) => i) : [];
  const leaderLeft = pos == null ? 0 : Math.min(0.9, Math.max(0.1, pos));

  const label = `${s.origin} to ${s.destination}. ${basis}.`;

  return (
    <section aria-label="Passage" className="min-w-0">
      {/* Ports */}
      <div className="grid grid-cols-2 gap-6">
        <div className="min-w-0">
          <p className="chart-label text-sea-ink-3">Origin</p>
          <p className="display mt-0.5 truncate text-[22px] leading-[28px] text-sea-ink">
            {s.origin}
          </p>
          <p
            className={`telemetry mt-0.5 text-[11px] uppercase ${departOverdue ? "font-medium text-sea-red" : "text-sea-ink-3"}`}
          >
            {s.actual_departure
              ? `Sailed ${utcDayTime(s.actual_departure, now)} UTC`
              : s.planned_etd
                ? `ETD ${utcDayTime(s.planned_etd, now)} UTC${departOverdue && now != null ? `  ${tCount(s.planned_etd, now).label}` : ""}`
                : "ETD not set"}
          </p>
        </div>
        <div className="min-w-0 text-right">
          <p className="chart-label text-sea-ink-3">Destination</p>
          <p
            className={`display mt-0.5 truncate text-[22px] leading-[28px] ${arrivalOverdue ? "text-sea-red" : "text-sea-ink"}`}
          >
            {s.destination}
          </p>
          <p className="telemetry mt-0.5 text-[11px] uppercase text-sea-ink-3">
            {voyage.arrived ? (
              <span className="text-sea-green">
                Arrived{s.actual_arrival ? ` ${utcDayTime(s.actual_arrival, now)} UTC` : ""}
              </span>
            ) : s.eta ? (
              <>
                ETA {utcDayTime(s.eta, now)} UTC
                {eta ? (
                  <span className={eta.past ? "ml-2 font-medium text-sea-red" : "ml-2"}>
                    {eta.label}
                  </span>
                ) : null}
                {Math.abs(slip) >= 1 ? (
                  <span className={`ml-2 ${slip > 0 ? "text-sea-amber-ink" : ""}`}>
                    {slipLabel(slip)} vs plan
                  </span>
                ) : null}
              </>
            ) : (
              <span className="text-sea-amber-ink">ETA not set</span>
            )}
          </p>
        </div>
      </div>

      {/* The chart strip */}
      <div
        role="img"
        aria-label={label}
        className="relative mt-4 h-[104px] border-y border-sea-rule bg-sea-surface"
        style={{
          backgroundImage:
            "linear-gradient(to right, var(--sea-grid) 1px, transparent 1px), linear-gradient(to bottom, var(--sea-grid) 1px, transparent 1px)",
          backgroundSize: "calc(100% / 16) 100%, 100% 26px",
        }}
      >
        <div className="absolute inset-x-[14px] inset-y-0 sm:inset-x-[18px]">
          {/* planned track */}
          <span
            aria-hidden
            className={`absolute inset-x-0 top-1/2 -translate-y-1/2 border-t ${
              voyage.arrived ? "border-solid border-sea-ink-3" : "border-dashed border-sea-ink-4"
            }`}
          />
          {/* track made good */}
          {pos != null && pos > 0 && !voyage.arrived ? (
            <span
              aria-hidden
              className={`absolute left-0 top-1/2 h-[3px] -translate-y-1/2 transition-[width] duration-700 ${
                moving ? "bg-sea-move" : "bg-sea-ink-2"
              }`}
              style={{ width: `${pos * 100}%` }}
            />
          ) : null}
          {/* day divisions */}
          {ticks.map((d) => (
            <span
              key={d}
              aria-hidden
              className="absolute bottom-0 flex -translate-x-1/2 flex-col items-center"
              style={{ left: `${(d / days) * 100}%` }}
            >
              <span
                className={`w-px ${d % step === 0 ? "h-[7px] bg-sea-ink-4" : "h-[4px] bg-sea-rule"}`}
              />
              {d % step === 0 && d !== days ? (
                <span className="telemetry absolute top-[-14px] text-[9px] text-sea-ink-4">
                  D{d}
                </span>
              ) : null}
            </span>
          ))}
          {/* ports */}
          <span
            aria-hidden
            className={`absolute left-0 top-1/2 size-[11px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 ${
              departOverdue
                ? "border-sea-red bg-sea-red"
                : pos == null && !voyage.arrived
                  ? "border-sea-ink bg-sea-ink"
                  : "border-sea-ink-2 bg-sea-surface"
            }`}
          />
          <span
            aria-hidden
            className={`absolute left-full top-1/2 size-[11px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 ${
              voyage.arrived
                ? "border-sea-green bg-sea-green"
                : arrivalOverdue
                  ? "border-sea-red bg-sea-surface outline outline-1 outline-offset-[3px] outline-sea-red/40"
                  : "border-sea-ink bg-sea-surface"
            }`}
          />
          {/* vessel, with the present moment drawn through it */}
          {!voyage.arrived && pos != null ? (
            <>
              <span
                aria-hidden
                className="absolute inset-y-[10px] w-px border-l border-dashed border-sea-ink-3"
                style={{ left: `${pos * 100}%` }}
              />
              <span
                aria-hidden
                className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 transition-[left] duration-700"
                style={{ left: `${pos * 100}%` }}
              >
                {target.state === "none" ? (
                  <span className="block size-[9px] rotate-45 bg-sea-ink-2" />
                ) : (
                  <AisTarget state={target.state} stopped={target.stopped} size={16} />
                )}
              </span>
              {s.vessel_name ? (
                <span
                  aria-hidden
                  className="telemetry absolute top-[8px] flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap bg-sea-surface px-1.5 text-[10px] uppercase text-sea-ink-2"
                  style={{ left: `${leaderLeft * 100}%` }}
                >
                  {moving ? <Bearing deg={target.cog} className="text-sea-move" size={9} /> : null}
                  <span
                    className={
                      moving ? "text-sea-move" : target.stopped ? "text-sea-amber-ink" : ""
                    }
                  >
                    {target.reading}
                  </span>
                  {now != null ? <span className="text-sea-ink-4">{utcClock(now)}Z</span> : null}
                </span>
              ) : null}
            </>
          ) : null}
        </div>
      </div>

      {/* Basis and fix */}
      <div className="mt-2.5 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 text-[12px]">
        <span className="text-sea-ink-2">{basis}</span>
        {position && target.state !== "none" ? (
          <span className="telemetry text-[10.5px] uppercase text-sea-ink-3">
            {formatCoordinates(position.latitude, position.longitude)}
            <span className={`ml-2 ${target.state === "lost" ? "text-sea-amber-ink" : ""}`}>
              Fix {target.age} ago{target.state === "lost" ? ", stale" : ""}
            </span>
          </span>
        ) : null}
      </div>
    </section>
  );
}
