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
import { Bearing, PassageLine, Skeleton, TCount } from "@/components/maritime/marks";

/** Voyages listed before the rest are handed to the board. */
const LIMIT = 4;

type Passage = { s: Shipment; voyage: Voyage; target: Target; moving: boolean };

/**
 * The network: where every voyage stands (alongside, at sea, arrived) as
 * one proportional bar, then each vessel at sea on its passage line with
 * the two readings a watch officer checks, time to ETA and the age of the
 * last AIS fix. Sits beside the attention queue as its context.
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
  const { passages, alongside, arrived, nextEtd, nextEta } = useMemo(() => {
    const passages: Passage[] = [];
    let alongside = 0;
    let arrived = 0;
    let nextEtd: Shipment | null = null;
    for (const s of shipments) {
      const voyage = voyageOf(s, now);
      if (voyage.arrived) {
        arrived += 1;
        continue;
      }
      if (!s.actual_departure) {
        alongside += 1;
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
    const nextEta =
      passages
        .filter((p) => p.s.eta && now != null && new Date(p.s.eta).getTime() >= now)
        .sort((a, b) => new Date(a.s.eta!).getTime() - new Date(b.s.eta!).getTime())[0]?.s ?? null;
    return { passages, alongside, arrived, nextEtd, nextEta };
  }, [shipments, positions, now]);

  const underway = passages.filter((p) => p.moving).length;
  const total = shipments.length;
  const stages = [
    { key: "alongside", label: "Alongside", n: alongside, bar: "bg-ww-steel/55" },
    { key: "sea", label: "At sea", n: passages.length, bar: "bg-sea-move" },
    { key: "arrived", label: "Arrived", n: arrived, bar: "bg-sea-green" },
  ];

  return (
    <section
      aria-labelledby="network-title"
      className="@container panel flex h-full min-w-0 flex-col overflow-hidden"
    >
      <header className="flex min-h-[56px] items-center justify-between gap-4 border-b border-sea-rule px-4 pb-2.5 pt-3.5 sm:px-5">
        <h2 id="network-title" className="panel-title !text-[15px]">
          Network
        </h2>
        {!isLoading && passages.length > 0 ? (
          <p className="flex items-center gap-1.5 text-[12px] text-sea-ink-2">
            {underway ? <Bearing deg={45} size={9} className="text-sea-move" /> : null}
            <span className={`telemetry text-[11px] ${underway ? "text-sea-move" : ""}`}>
              {underway}
            </span>
            under way on AIS
          </p>
        ) : null}
      </header>

      <div className="flex-1 @2xl:grid @2xl:grid-cols-[minmax(240px,300px)_minmax(0,1fr)]">
        {/* Where every voyage stands, to scale */}
        <div className="border-b border-sea-rule-2 px-4 py-4 sm:px-5 @2xl:border-b-0 @2xl:border-r">
          {isLoading ? (
            <Skeleton className="h-[34px] w-full rounded-sm" />
          ) : (
            <>
              <div
                className="flex h-[6px] gap-[3px]"
                role="img"
                aria-label={stages.map((st) => `${st.n} ${st.label.toLowerCase()}`).join(", ")}
              >
                {total === 0 ? (
                  <span className="flex-1 rounded-full bg-sea-paper-2" />
                ) : (
                  stages
                    .filter((st) => st.n > 0)
                    .map((st) => (
                      <span
                        key={st.key}
                        className={`rounded-full ${st.bar} transition-[flex-grow] duration-700`}
                        style={{ flexGrow: st.n, flexBasis: 0 }}
                      />
                    ))
                )}
              </div>
              <dl className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1 text-[12px]">
                {stages.map((st) => (
                  <div key={st.key} className="flex items-center gap-1.5">
                    <span
                      aria-hidden
                      className={`inline-block h-[6px] w-2.5 rounded-full ${st.bar}`}
                    />
                    <dt className="text-sea-ink-3">{st.label}</dt>
                    <dd className="telemetry text-[11.5px] font-medium text-sea-ink">{st.n}</dd>
                  </div>
                ))}
              </dl>
            </>
          )}
        </div>

        <div className="flex-1">
          {isLoading ? (
            Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="border-b border-sea-rule-2 px-5 py-4">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="mt-3 h-[2px] w-full" />
              </div>
            ))
          ) : passages.length === 0 ? (
            <div className="px-4 py-6 sm:px-5">
              <p className="text-[13.5px] font-medium text-sea-ink">No vessel at sea</p>
              <p className="mt-0.5 text-[12.5px] text-sea-ink-2">
                {alongside === 0
                  ? "Voyages appear here from their recorded departure."
                  : nextEtd?.planned_etd
                    ? `Next sails ${shortDate(nextEtd.planned_etd, now)} from ${nextEtd.origin}.`
                    : `${alongside} awaiting departure.`}
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
      </div>

      {/* The next two movements on the network */}
      {!isLoading && shipments.length > 0 ? (
        <dl className="mt-auto grid grid-cols-2 border-t border-sea-rule bg-sea-paper/45 text-[12px]">
          {(
            [
              ["Next departure", nextEtd, nextEtd?.planned_etd, nextEtd?.origin],
              ["Next arrival", nextEta, nextEta?.eta, nextEta?.destination],
            ] as const
          ).map(([label, ship, at, port], i) => {
            const late = at != null && now != null && new Date(at).getTime() < now;
            return (
              <div
                key={label}
                className={`min-w-0 px-4 py-2.5 sm:px-5 ${i ? "border-l border-sea-rule-2" : ""}`}
              >
                <dt className="text-[11.5px] text-sea-ink-3">{label}</dt>
                <dd className="mt-0.5 truncate">
                  {ship && at ? (
                    <Link
                      to="/shipments/$id"
                      params={{ id: ship.id }}
                      className="focus-ring rounded-sm hover:text-ww-blue"
                    >
                      <span
                        className={`telemetry text-[11px] uppercase ${late ? "font-medium text-sea-red" : "text-sea-ink"}`}
                      >
                        {shortDate(at, now)}
                      </span>{" "}
                      <span className="text-sea-ink-2">{port}</span>
                    </Link>
                  ) : (
                    <span className="text-sea-ink-4">None scheduled</span>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      ) : null}

      {passages.length > LIMIT ? (
        <button
          type="button"
          onClick={onShowAll}
          className="focus-ring flex h-10 items-center justify-center gap-1.5 border-t border-sea-rule bg-sea-paper/45 text-[12.5px] font-medium text-ww-blue hover:text-ww-blue-hover"
        >
          All {passages.length} at sea on the board <ArrowRight className="size-3.5" aria-hidden />
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
  const lost = target.state === "lost";
  const late = s.eta != null && now != null && new Date(s.eta).getTime() < now;
  return (
    <li className="border-b border-sea-rule-2 last:border-b-0">
      <Link
        to="/shipments/$id"
        params={{ id: s.id }}
        onMouseEnter={() => onFocus(s.id)}
        onMouseLeave={() => onFocus(null)}
        onFocus={() => onFocus(s.id)}
        onBlur={() => onFocus(null)}
        className={`focus-ring block px-4 py-3 transition-colors duration-150 hover:bg-sea-shallows sm:px-5 ${lit ? "bg-sea-shallows" : ""}`}
      >
        {/* Vessel and its reading */}
        <span className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate">
            <span className="vessel text-[13.5px] !font-semibold text-sea-ink">
              {s.vessel_name ?? "Vessel not named"}
            </span>
            <span className="ml-2 text-[12px] text-sea-ink-3">{s.client_name}</span>
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

        {/* The passage */}
        <span className="mt-2 grid grid-cols-[minmax(0,1fr)_minmax(80px,1.8fr)_minmax(0,1fr)] items-center gap-2.5 text-[12px]">
          <span className="truncate text-sea-ink-2">{s.origin}</span>
          <PassageLine
            pos={voyage.pos}
            moving={moving}
            target={target.state}
            stopped={target.stopped}
            arrivalOverdue={late}
          />
          <span
            className={`truncate text-right ${late ? "font-medium text-sea-red" : "font-medium text-sea-ink"}`}
          >
            {s.destination}
          </span>
        </span>

        {/* ETA and fix */}
        <span className="mt-1.5 flex items-baseline justify-between gap-3 text-[12px]">
          <span className="flex items-baseline gap-2 text-sea-ink-2">
            {s.eta ? (
              <>
                <span className="telemetry text-[11px] uppercase text-sea-ink-3">ETA</span>
                <span className="font-medium text-sea-ink">{shortDate(s.eta, now)}</span>
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
