import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { useMemo } from "react";

import type { Shipment, VesselPosition } from "@/lib/api";
import { deriveVesselCondition } from "@/lib/aisAutomation";
import {
  shortDate,
  targetOf,
  voyageOf,
  type Target,
  type Voyage,
} from "@/components/maritime/format";
import { AisTarget, Bearing, Skeleton, TCount } from "@/components/maritime/marks";

/** Voyages listed before the rest are handed to the board. */
const LIMIT = 5;

type Passage = { s: Shipment; voyage: Voyage; target: Target; moving: boolean };

/**
 * What is moving: every voyage that has sailed and not yet arrived, read
 * as a vessel on its passage. The vessel leads (it is what AIS reports),
 * then the passage drawn to scale by schedule, then the two readings a
 * watch officer checks: time to ETA and the age of the last fix.
 */
export function AtSea({
  shipments,
  positions,
  now,
  isLoading,
  focusId,
  onFocus,
  onShowAll,
}: {
  shipments: Shipment[];
  positions: Map<string, VesselPosition> | undefined;
  now: number | null;
  isLoading: boolean;
  focusId: string | null;
  onFocus: (id: string | null) => void;
  onShowAll: () => void;
}) {
  const { passages, waiting, nextEtd } = useMemo(() => {
    const passages: Passage[] = [];
    let waiting = 0;
    let nextEtd: Shipment | null = null;
    for (const s of shipments) {
      const voyage = voyageOf(s, now);
      if (voyage.arrived) continue;
      if (!s.actual_departure) {
        waiting += 1;
        if (s.planned_etd && (!nextEtd || new Date(s.planned_etd) < new Date(nextEtd.planned_etd!)))
          nextEtd = s;
        continue;
      }
      const position = s.vessel_mmsi ? (positions?.get(s.vessel_mmsi) ?? null) : null;
      const kind = positions && s.vessel_mmsi ? deriveVesselCondition(s, position).kind : null;
      const target = targetOf(position, kind, Boolean(s.vessel_mmsi), now);
      passages.push({ s, voyage, target, moving: target.state === "active" });
    }
    const eta = (p: Passage) => (p.s.eta ? new Date(p.s.eta).getTime() : Infinity);
    passages.sort((a, b) => Number(b.moving) - Number(a.moving) || eta(a) - eta(b));
    return { passages, waiting, nextEtd };
  }, [shipments, positions, now]);

  const underway = passages.filter((p) => p.moving).length;

  return (
    <section aria-labelledby="atsea-title" className="min-w-0">
      <header className="flex items-end justify-between gap-4 pb-3">
        <div className="flex items-baseline gap-3">
          <h2 id="atsea-title" className="display text-[19px] leading-[24px] text-sea-ink">
            At sea
          </h2>
          {!isLoading ? (
            <span
              className={`figure text-[26px] leading-[24px] ${passages.length ? "text-sea-ink" : "text-sea-ink-4"}`}
            >
              {passages.length}
            </span>
          ) : null}
        </div>
        {!isLoading && passages.length > 0 ? (
          <p className="text-[12px] text-sea-ink-2">
            <span className={`telemetry text-[11px] ${underway ? "text-sea-move" : ""}`}>
              {underway}
            </span>{" "}
            under way on AIS
          </p>
        ) : null}
      </header>

      <div className="border-t border-sea-ink">
        {isLoading ? (
          Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="border-b border-sea-rule-2 py-4">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="mt-3 h-[2px] w-full" />
            </div>
          ))
        ) : passages.length === 0 ? (
          <div className="border-b border-sea-rule-2 py-6">
            <p className="text-[14px] font-medium text-sea-ink">No vessel at sea</p>
            <p className="mt-0.5 text-[13px] text-sea-ink-2">
              {waiting === 0
                ? "Voyages appear here from their recorded departure."
                : nextEtd?.planned_etd
                  ? `${waiting} awaiting departure. Next sails ${shortDate(nextEtd.planned_etd, now)} from ${nextEtd.origin}.`
                  : `${waiting} awaiting departure.`}
            </p>
          </div>
        ) : (
          <ol>
            {passages.slice(0, LIMIT).map((p) => (
              <PassageRow
                key={p.s.id}
                passage={p}
                now={now}
                lit={focusId === p.s.id}
                onFocus={onFocus}
              />
            ))}
          </ol>
        )}
      </div>

      {passages.length > LIMIT ? (
        <button
          type="button"
          onClick={onShowAll}
          className="focus-ring mt-2.5 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-sea-ink hover:underline"
        >
          All {passages.length} on the board <ArrowRight className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </section>
  );
}

function PassageRow({
  passage,
  now,
  lit,
  onFocus,
}: {
  passage: Passage;
  now: number | null;
  lit: boolean;
  onFocus: (id: string | null) => void;
}) {
  const { s, voyage, target, moving } = passage;
  const pos = voyage.pos ?? 0;
  const lost = target.state === "lost";
  const late = s.eta != null && now != null && new Date(s.eta).getTime() < now;
  return (
    <li className="border-b border-sea-rule-2">
      <Link
        to="/shipments/$id"
        params={{ id: s.id }}
        onMouseEnter={() => onFocus(s.id)}
        onMouseLeave={() => onFocus(null)}
        onFocus={() => onFocus(s.id)}
        onBlur={() => onFocus(null)}
        className={`focus-ring -mx-2 block px-2 py-3 transition-colors duration-150 hover:bg-sea-shallows/60 ${lit ? "bg-sea-shallows/60" : ""}`}
      >
        {/* Vessel and its reading */}
        <span className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate text-[14px] font-medium text-sea-ink">
            {s.vessel_name ?? "Vessel not named"}
            <span className="ml-2 text-[12px] font-normal text-sea-ink-3">{s.client_name}</span>
          </span>
          <span
            className={`telemetry flex shrink-0 items-center gap-1.5 text-[11px] uppercase ${
              moving
                ? "text-sea-move"
                : lost || target.stopped
                  ? "text-sea-amber-ink"
                  : "text-sea-ink-3"
            }`}
          >
            {moving ? <Bearing deg={target.cog} size={9} /> : null}
            {target.reading}
            {moving && target.cog != null ? (
              <span className="text-sea-ink-3">
                {String(Math.round(target.cog)).padStart(3, "0")}°
              </span>
            ) : null}
          </span>
        </span>

        {/* The passage to scale by schedule */}
        <span className="mt-2 grid grid-cols-[minmax(0,1fr)_minmax(90px,2fr)_minmax(0,1fr)] items-center gap-2.5 text-[12px] text-sea-ink-2">
          <span className="truncate">{s.origin}</span>
          <span aria-hidden className="relative mx-[4px] block h-[12px]">
            <span className="absolute inset-x-0 top-1/2 border-t border-dotted border-sea-ink-4" />
            <span
              className={`absolute left-0 top-1/2 h-[2px] -translate-y-1/2 ${moving ? "bg-sea-move" : "bg-sea-ink-2"}`}
              style={{ width: `${pos * 100}%` }}
            />
            <span className="absolute left-0 top-1/2 size-[6px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] border-sea-ink-2 bg-sea-surface" />
            <span
              className={`absolute left-full top-1/2 size-[6px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] bg-sea-surface ${late ? "border-sea-red" : "border-sea-ink"}`}
            />
            <span
              className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
              style={{ left: `${pos * 100}%` }}
            >
              {target.state === "none" ? (
                <span className="block size-[6px] rotate-45 bg-sea-ink-2" />
              ) : (
                <AisTarget state={target.state} stopped={target.stopped} size={12} />
              )}
            </span>
          </span>
          <span
            className={`truncate text-right ${late ? "font-medium text-sea-red" : "text-sea-ink"}`}
          >
            {s.destination}
          </span>
        </span>

        {/* ETA and fix */}
        <span className="mt-1.5 flex items-baseline justify-between gap-3 text-[12px]">
          <span className="flex items-baseline gap-2 text-sea-ink-2">
            {s.eta ? (
              <>
                <span>
                  ETA <span className="font-medium text-sea-ink">{shortDate(s.eta, now)}</span>
                </span>
                <TCount iso={s.eta} now={now} />
              </>
            ) : (
              <span className="text-sea-amber-ink">ETA not set</span>
            )}
            {voyage.day ? (
              <span className="telemetry text-[10.5px] text-sea-ink-3">
                D{voyage.day.elapsed}/{voyage.day.total}
              </span>
            ) : null}
          </span>
          <span
            className={`telemetry text-[10.5px] uppercase ${lost ? "text-sea-amber-ink" : "text-sea-ink-3"}`}
          >
            {target.age ? `Fix ${target.age} ago` : s.vessel_mmsi ? "No fix" : "No MMSI"}
          </span>
        </span>
      </Link>
    </li>
  );
}
