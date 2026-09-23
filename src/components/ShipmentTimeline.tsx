import { SourceMark } from "@/components/maritime/marks";
import { slipLabel, utcDayTime } from "@/components/maritime/format";
import { buildTimeline, drift } from "@/lib/lifecycle";
import type { Shipment, ShipmentEvent } from "@/lib/api";

/**
 * The voyage's milestones as a schedule table: what was planned, what is
 * now expected or has actually happened, the variance between them, and
 * which source recorded it. Anything not yet recorded stays blank rather
 * than being estimated.
 */
export function ShipmentTimeline({
  shipment: s,
  events,
}: {
  shipment: Shipment;
  events: ShipmentEvent[];
}) {
  const timeline = buildTimeline(s, events);
  const src = (key: string) => timeline.find((t) => t.key === key);
  const dep = drift(s.planned_etd, s.actual_departure);
  const eta = drift(s.planned_eta, s.eta);
  const arr = drift(s.planned_eta, s.actual_arrival);

  const rows: {
    label: string;
    planned: string | null;
    actual: { text: string; kind: "actual" | "expected" } | null;
    variance: number | null;
    source: { source?: string | undefined; automated?: boolean | undefined } | undefined;
  }[] = [
    {
      label: "Departure",
      planned: s.planned_etd,
      actual: s.actual_departure ? { text: s.actual_departure, kind: "actual" } : null,
      variance: s.actual_departure ? (dep?.hours ?? null) : null,
      source: src("actual_departure"),
    },
    {
      label: "Arrival",
      planned: s.planned_eta,
      actual: s.actual_arrival
        ? { text: s.actual_arrival, kind: "actual" }
        : s.eta
          ? { text: s.eta, kind: "expected" }
          : null,
      variance: s.actual_arrival ? (arr?.hours ?? null) : (eta?.hours ?? null),
      source: s.actual_arrival ? src("actual_arrival") : src("current_eta"),
    },
  ];

  return (
    <section aria-labelledby="milestones-title">
      <h2 id="milestones-title" className="chart-label border-b border-sea-ink pb-2 text-sea-ink">
        Milestones{" "}
        <span className="ml-2 font-normal normal-case tracking-normal text-sea-ink-3">UTC</span>
      </h2>
      <table className="w-full table-fixed text-left">
        <thead>
          <tr className="border-b border-sea-rule">
            <th className="chart-label w-[22%] py-2 font-normal text-sea-ink-3">Milestone</th>
            <th className="chart-label py-2 font-normal text-sea-ink-3">Planned</th>
            <th className="chart-label py-2 font-normal text-sea-ink-3">Actual / expected</th>
            <th className="chart-label w-[64px] py-2 text-right font-normal text-sea-ink-3">Var</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-b border-sea-rule-2 align-top">
              <td className="py-2.5 pr-3 text-[13px] font-medium text-sea-ink">{r.label}</td>
              <td className="telemetry py-2.5 pr-3 text-[11px] uppercase text-sea-ink-2">
                {r.planned ? (
                  utcDayTime(r.planned)
                ) : (
                  <span className="text-sea-amber-ink">Not set</span>
                )}
              </td>
              <td className="py-2.5 pr-3">
                {r.actual ? (
                  <span className="telemetry flex items-center gap-1.5 text-[11px] uppercase text-sea-ink">
                    {r.source?.source ? (
                      <SourceMark
                        source={r.source.source}
                        automated={Boolean(r.source.automated)}
                      />
                    ) : null}
                    {r.actual.kind === "expected" ? "ETA " : ""}
                    {utcDayTime(r.actual.text)}
                  </span>
                ) : (
                  <span className="text-[12px] text-sea-ink-3">Not yet recorded</span>
                )}
              </td>
              <td
                className={`telemetry py-2.5 text-right text-[11px] ${
                  r.variance == null || r.variance === 0
                    ? "text-sea-ink-4"
                    : r.variance > 0
                      ? "text-sea-amber-ink"
                      : "text-sea-ink-2"
                }`}
              >
                {r.variance == null ? "" : r.variance === 0 ? "0H" : slipLabel(r.variance)}
              </td>
            </tr>
          ))}
          <tr className="border-b border-sea-rule-2">
            <td className="py-2.5 pr-3 text-[13px] text-sea-ink-2">Record opened</td>
            <td className="telemetry py-2.5 text-[11px] uppercase text-sea-ink-3" colSpan={3}>
              {utcDayTime(s.created_at)}
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}
