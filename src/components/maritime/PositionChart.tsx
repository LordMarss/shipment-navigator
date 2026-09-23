import { formatCoordinates, type TargetState } from "@/components/maritime/format";

export type ChartTarget = {
  mmsi: string;
  name: string;
  lat: number;
  lon: number;
  cog: number | null;
  state: TargetState;
  stopped: boolean;
  /** Fix age, "16h". */
  age: string | null;
  /** The shipments this vessel carries, for the label. */
  voyages: number;
};

const W = 1000;
const H = 560;
const PAD = 70;
const STEPS = [1, 2, 5, 10, 15, 20, 30, 45];

/**
 * Last AIS fixes plotted by latitude and longitude on a plain graticule,
 * fitted to the fleet. No coastline is drawn: this is a position plot, not
 * a map, and it says so. Each vessel is its AIS target turned to its course
 * over ground; selecting one hands it to the tracker.
 */
export function PositionChart({
  targets,
  selected,
  onSelect,
}: {
  targets: ChartTarget[];
  selected: string | null;
  onSelect: (mmsi: string) => void;
}) {
  if (targets.length === 0) {
    return (
      <div className="grid h-[420px] place-items-center px-6 text-center lg:h-[560px]">
        <div>
          <p className="text-[14px] font-medium text-sea-ink">No AIS positions yet</p>
          <p className="mt-1 max-w-[44ch] text-[13px] text-sea-ink-2">
            Record a vessel MMSI on a shipment. Its last fix is plotted here once AIS reports it.
          </p>
        </div>
      </div>
    );
  }

  // Fit the fleet with a margin, never tighter than 16 by 10 degrees, then
  // widen whichever span is short so a degree reads the same both ways.
  const lats = targets.map((t) => t.lat);
  const lons = targets.map((t) => t.lon);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const midLon = (Math.min(...lons) + Math.max(...lons)) / 2;
  let lonSpan = Math.max(16, (Math.max(...lons) - Math.min(...lons)) * 1.3);
  let latSpan = Math.max(10, (Math.max(...lats) - Math.min(...lats)) * 1.3);
  const aspect = (W - PAD * 2) / (H - PAD * 2);
  if (lonSpan / latSpan < aspect) lonSpan = latSpan * aspect;
  else latSpan = lonSpan / aspect;
  const west = midLon - lonSpan / 2;
  const north = midLat + latSpan / 2;
  const x = (lon: number) => PAD + ((lon - west) / lonSpan) * (W - PAD * 2);
  const y = (lat: number) => PAD + ((north - lat) / latSpan) * (H - PAD * 2);

  const step = STEPS.find((s) => lonSpan / s <= 8) ?? 60;
  const lonLines: number[] = [];
  for (let v = Math.ceil(west / step) * step; v <= west + lonSpan; v += step) lonLines.push(v);
  const latLines: number[] = [];
  for (let v = Math.floor(north / step) * step; v >= north - latSpan; v -= step) latLines.push(v);

  const lonLabel = (v: number) =>
    `${Math.abs(((v + 540) % 360) - 180)}°${((v + 540) % 360) - 180 < 0 ? "W" : "E"}`;
  const latLabel = (v: number) => `${Math.abs(v)}°${v < 0 ? "S" : "N"}`;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="block h-auto w-full bg-sea-surface"
      role="group"
      aria-label={`Last AIS positions of ${targets.length} vessel${targets.length === 1 ? "" : "s"}`}
    >
      {/* graticule */}
      {lonLines.map((v) => (
        <g key={`lon${v}`}>
          <line x1={x(v)} x2={x(v)} y1={PAD / 2} y2={H - PAD / 2} stroke="var(--sea-rule-2)" />
          <text
            x={x(v)}
            y={H - PAD / 2 + 20}
            textAnchor="middle"
            className="telemetry"
            fontSize="13"
            fill="var(--sea-ink-3)"
          >
            {lonLabel(v)}
          </text>
        </g>
      ))}
      {latLines.map((v) => (
        <g key={`lat${v}`}>
          <line x1={PAD / 2} x2={W - PAD / 2} y1={y(v)} y2={y(v)} stroke="var(--sea-rule-2)" />
          <text
            x={PAD / 2 + 6}
            y={y(v) - 5}
            textAnchor="start"
            className="telemetry"
            fontSize="13"
            fill="var(--sea-ink-3)"
          >
            {latLabel(v)}
          </text>
        </g>
      ))}
      <rect
        x={PAD / 2}
        y={PAD / 2}
        width={W - PAD}
        height={H - PAD}
        fill="none"
        stroke="var(--sea-rule)"
      />

      {/* targets */}
      {targets.map((t) => {
        const on = selected === t.mmsi;
        const color =
          t.state === "active"
            ? "var(--sea-move)"
            : t.state === "lost"
              ? "var(--sea-ink-4)"
              : t.stopped
                ? "var(--sea-amber-ink)"
                : "var(--sea-ink-2)";
        const tx = x(t.lon);
        const ty = y(t.lat);
        const labelRight = tx < W - 260;
        return (
          <g
            key={t.mmsi}
            role="button"
            tabIndex={0}
            aria-pressed={on}
            aria-label={`${t.name}, ${formatCoordinates(t.lat, t.lon)}, fix ${t.age ?? "unknown"} ago. Track this vessel.`}
            onClick={() => onSelect(t.mmsi)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(t.mmsi);
              }
            }}
            className="cursor-pointer outline-none [&:focus-visible>circle.ring]:opacity-100"
          >
            <circle
              className="ring"
              cx={tx}
              cy={ty}
              r={21}
              fill="none"
              stroke="var(--sea-move)"
              strokeWidth={2}
              opacity={on ? 1 : 0}
            />
            <circle cx={tx} cy={ty} r={22} fill="transparent" />
            <g transform={`translate(${tx} ${ty}) rotate(${t.cog ?? 0})`}>
              <path
                d="M0 -13 L8.5 9 L0 4.5 L-8.5 9 Z"
                fill={t.state === "active" ? color : "var(--sea-surface)"}
                stroke={color}
                strokeWidth={1.6}
                strokeLinejoin="round"
              />
            </g>
            {t.state === "lost" ? (
              <line
                x1={tx - 11}
                y1={ty + 11}
                x2={tx + 11}
                y2={ty - 11}
                stroke="var(--sea-ink-3)"
                strokeWidth={1.4}
              />
            ) : null}
            <text
              x={labelRight ? tx + 22 : tx - 22}
              y={ty - 2}
              textAnchor={labelRight ? "start" : "end"}
              fontSize="17"
              fontWeight={on ? 600 : 500}
              fill="var(--sea-ink)"
            >
              {t.name}
            </text>
            <text
              x={labelRight ? tx + 22 : tx - 22}
              y={ty + 16}
              textAnchor={labelRight ? "start" : "end"}
              className="telemetry"
              fontSize="12.5"
              fill="var(--sea-ink-3)"
            >
              {formatCoordinates(t.lat, t.lon)}
              {t.age ? `  ${t.age.toUpperCase()} AGO` : ""}
              {t.voyages > 1 ? `  ${t.voyages} VOYAGES` : ""}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
