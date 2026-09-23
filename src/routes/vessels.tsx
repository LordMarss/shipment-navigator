import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo } from "react";

import { AppShell } from "@/components/AppShell";
import { StatusPill } from "@/components/StatusPill";
import { formatCoordinates, shortDate, targetOf, tCount } from "@/components/maritime/format";
import { AisTarget, ChartPanel, Skeleton } from "@/components/maritime/marks";
import { Readouts } from "@/components/maritime/Readouts";
import { useFleet } from "@/components/maritime/useFleet";
import { useNow } from "@/components/maritime/useNow";
import { deriveVesselCondition } from "@/lib/aisAutomation";
import { shortId, type Shipment } from "@/lib/api";

export const Route = createFileRoute("/vessels")({
  head: () => ({
    meta: [
      { title: "Vessels - StimTech Solutions" },
      {
        name: "description",
        content: "Every vessel carrying one of your shipments, with MMSI, route and ETA.",
      },
      { property: "og:title", content: "Vessels - StimTech Solutions" },
      {
        property: "og:description",
        content: "Vessels tracked across your active and completed shipments.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: VesselsPage,
});

const FINISHED = new Set(["Arrived", "At Port", "Cleared Customs", "Delivered"]);

type VesselEntry = { key: string; name: string; mmsi: string | null; voyages: Shipment[] };

/**
 * The vessel register: one entry per vessel (keyed by MMSI, or by name when
 * no MMSI is recorded), its AIS target and last fix, and every voyage it
 * carries for you. Same data as before, grouped the way a harbour office
 * keeps a register.
 */
function VesselsPage() {
  const now = useNow();
  const { shipments, positions, isLoading } = useFleet();

  const vessels = useMemo(() => {
    const map = new Map<string, VesselEntry>();
    for (const s of shipments) {
      if (!s.vessel_name && !s.vessel_mmsi) continue;
      const key = s.vessel_mmsi ?? `name:${s.vessel_name}`;
      const entry = map.get(key) ?? {
        key,
        name: s.vessel_name || "Unnamed vessel",
        mmsi: s.vessel_mmsi,
        voyages: [],
      };
      entry.voyages.push(s);
      map.set(key, entry);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [shipments]);

  const targets = vessels.map((v) => {
    const position = v.mmsi ? (positions?.get(v.mmsi) ?? null) : null;
    const lead = v.voyages.find((s) => !FINISHED.has(s.status)) ?? v.voyages[0]!;
    const kind = position ? deriveVesselCondition(lead, position).kind : null;
    return { v, position, target: targetOf(position, kind, Boolean(v.mmsi), now) };
  });
  const underway = targets.filter((t) => t.target.state === "active").length;
  const lost = targets.filter((t) => t.target.state === "lost").length;
  const noMmsi = vessels.filter((v) => !v.mmsi).length;

  return (
    <AppShell
      title="Fleet"
      description="Vessels resolved from the MMSI recorded on your shipments."
      wide
      headerExtra={
        <Readouts
          loading={isLoading}
          items={[
            { label: "Vessels", value: vessels.length },
            {
              label: "Under way",
              value: underway,
              ...(underway > 0 ? { tone: "move" as const } : {}),
            },
            { label: "Lost signal", value: lost },
            { label: "No MMSI", value: noMmsi },
          ]}
        />
      }
    >
      <ChartPanel
        id="register"
        title="Register"
        meta={isLoading ? null : `${vessels.length} vessels`}
      >
        {isLoading ? (
          <div className="space-y-3 py-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : vessels.length === 0 ? (
          <div className="border-b border-sea-rule-2 py-10">
            <p className="text-[14px] font-medium text-sea-ink">No vessels yet</p>
            <p className="mt-1 text-[13px] text-sea-ink-2">
              Add a vessel name or MMSI to a shipment and it will be entered here.
            </p>
          </div>
        ) : (
          <table className="w-full border-collapse text-left">
            <thead className="max-md:hidden">
              <tr className="shadow-[inset_0_-1px_0_var(--sea-rule)]">
                {["Vessel", "AIS", "Last fix", "Voyages carried"].map((h) => (
                  <th key={h} scope="col" className="label-xs py-2 pr-6 font-normal">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {targets.map(({ v, position, target }) => (
                <tr
                  key={v.key}
                  className="border-b border-sea-rule-2 align-top max-md:grid max-md:gap-2 max-md:py-3.5"
                >
                  <td className="py-3.5 pr-6 md:w-[24%]">
                    <span className="flex items-center gap-2.5">
                      <span className="w-4 shrink-0">
                        <AisTarget state={target.state} stopped={target.stopped} size={12} />
                      </span>
                      <span className="text-[14px] font-medium text-sea-ink">{v.name}</span>
                    </span>
                    <span className="telemetry mt-1 block pl-[26px] text-[11px] text-sea-ink-3">
                      {v.mmsi ? `MMSI ${v.mmsi}` : "No MMSI recorded"}
                    </span>
                  </td>
                  <td className="py-3.5 pr-6 max-md:py-0 max-md:pl-[26px] md:w-[16%]">
                    <span
                      className={`telemetry text-[12px] ${
                        target.state === "active"
                          ? "text-sea-move"
                          : target.stopped
                            ? "text-sea-amber-ink"
                            : "text-sea-ink-3"
                      }`}
                    >
                      {target.reading}
                    </span>
                    {target.cog != null && target.state !== "none" && target.state !== "lost" ? (
                      <span className="telemetry mt-1 block text-[11px] text-sea-ink-3">
                        COG {String(Math.round(target.cog)).padStart(3, "0")}°
                      </span>
                    ) : null}
                  </td>
                  <td className="py-3.5 pr-6 max-md:py-0 max-md:pl-[26px] md:w-[22%]">
                    {position ? (
                      <>
                        <span className="telemetry block text-[11.5px] text-sea-ink-2">
                          {formatCoordinates(position.latitude, position.longitude)}
                        </span>
                        <span className="telemetry mt-1 block text-[11px] text-sea-ink-3">
                          {target.age ? `${target.age} ago` : ""}
                        </span>
                      </>
                    ) : (
                      <span className="text-[12.5px] text-sea-ink-3">No position received</span>
                    )}
                  </td>
                  <td className="py-3.5 max-md:py-0 max-md:pl-[26px]">
                    <ul className="space-y-1.5">
                      {v.voyages.map((s) => (
                        <li key={s.id}>
                          <Link
                            to="/shipments/$id"
                            params={{ id: s.id }}
                            className="focus-ring group grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 rounded-[1px] text-[12.5px] hover:bg-sea-shallows/60 md:grid-cols-[84px_minmax(0,1fr)_auto_auto]"
                          >
                            <span className="telemetry text-[11px] text-sea-ink-2 underline-offset-2 group-hover:underline max-md:hidden">
                              {shortId(s.id)}
                            </span>
                            <span className="truncate text-sea-ink">
                              {s.client_name}
                              <span className="ml-2 text-sea-ink-3">
                                {s.origin} → {s.destination}
                              </span>
                            </span>
                            <span className="text-[12px] max-md:hidden">
                              <StatusPill status={s.status} />
                            </span>
                            <span className="telemetry text-right text-[11px] text-sea-ink-2">
                              {s.eta ? shortDate(s.eta, now) : "No ETA"}
                              {s.eta && now != null && !FINISHED.has(s.status) ? (
                                <span
                                  className={`ml-2 ${tCount(s.eta, now).past ? "text-sea-red" : "text-sea-ink-3"}`}
                                >
                                  {tCount(s.eta, now).label}
                                </span>
                              ) : null}
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </ChartPanel>
    </AppShell>
  );
}
