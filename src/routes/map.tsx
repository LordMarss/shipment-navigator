import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { AppShell, btnGhost, btnPrimary, fieldClass } from "@/components/AppShell";
import { StatusPill } from "@/components/StatusPill";
import { targetOf } from "@/components/maritime/format";
import { AisTarget, ChartPanel } from "@/components/maritime/marks";
import { Readouts } from "@/components/maritime/Readouts";
import { useFleet } from "@/components/maritime/useFleet";
import { useNow } from "@/components/maritime/useNow";
import { deriveVesselCondition } from "@/lib/aisAutomation";
import { shortId, updateShipment, type Shipment } from "@/lib/api";

export const Route = createFileRoute("/map")({
  head: () => ({
    meta: [
      { title: "Fleet Map - StimTech Solutions" },
      {
        name: "description",
        content:
          "Live vessel traffic across Pacific shipping lanes, with per-shipment vessel tracking by MMSI.",
      },
      { property: "og:title", content: "Fleet Map - StimTech Solutions" },
      {
        property: "og:description",
        content: "Watch the vessel carrying each shipment on a live traffic map.",
      },
    ],
  }),
  component: FleetMap,
});

// MarineTraffic public embed - no API key or account required.
const GLOBAL_EMBED =
  "https://www.marinetraffic.com/en/ais/embed/zoom:4/centery:38/centerx:-140/maptype:4/shownames:false/mmsi:0/shipid:0/fleet:/fleet_id:/vessel_type:/remember:false";

function vesselEmbed(mmsi: string) {
  return `https://www.marinetraffic.com/en/ais/embed/zoom:9/maptype:4/shownames:true/mmsi:${encodeURIComponent(
    mmsi,
  )}/shipid:0/fleet:/fleet_id:/vessel_type:/remember:false`;
}

function FleetMap() {
  const queryClient = useQueryClient();
  const [tracked, setTracked] = useState<Shipment | null>(null);
  const [mmsiDraft, setMmsiDraft] = useState<Record<string, string>>({});

  const now = useNow();
  const { shipments, positions, isLoading } = useFleet();
  const active = shipments.filter((s) => s.status !== "Delivered");
  const targetFor = (s: Shipment) => {
    const position = s.vessel_mmsi ? (positions?.get(s.vessel_mmsi) ?? null) : null;
    const kind = position ? deriveVesselCondition(s, position).kind : null;
    return targetOf(position, kind, Boolean(s.vessel_mmsi), now);
  };
  const underway = active.filter((s) => targetFor(s).state === "active").length;
  const trackedByAis = active.filter((s) => s.vessel_mmsi).length;
  const inTransitCount = active.filter((s) => s.status === "In Transit").length;

  const saveMmsi = useMutation({
    mutationFn: ({ id, mmsi }: { id: string; mmsi: string }) =>
      updateShipment(id, { vessel_mmsi: mmsi }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["shipments"] });
      toast.success("Vessel MMSI saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <AppShell
      title="Fleet Map"
      description="Live AIS traffic. Track the vessel carrying any active shipment."
      actions={
        tracked ? (
          <button className={btnGhost} onClick={() => setTracked(null)}>
            Back to full map
          </button>
        ) : null
      }
      headerExtra={
        <Readouts
          loading={isLoading}
          items={[
            { label: "Active", value: active.length },
            { label: "Tracked by AIS", value: trackedByAis },
            { label: "In transit", value: inTransitCount },
            {
              label: "Under way",
              value: underway,
              ...(underway > 0 ? { tone: "move" as const } : {}),
            },
          ]}
        />
      }
    >
      <div className="grid grid-cols-1 gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 self-start overflow-hidden border border-border bg-surface lg:sticky lg:top-[calc(var(--rail-h)+16px)]">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
            <span className="label-xs inline-flex items-center gap-2 text-foreground">
              {tracked ? (
                <span
                  className="inline-flex size-1.5 shrink-0 rounded-full bg-sea-move live-pulse"
                  aria-hidden
                />
              ) : null}
              {tracked
                ? `Tracking ${shortId(tracked.id)} · ${tracked.vessel_name || "vessel"} (MMSI ${tracked.vessel_mmsi})`
                : "Global traffic · Pacific Coast / North America lanes"}
            </span>
            {tracked ? <StatusPill status={tracked.status} /> : null}
          </div>
          <iframe
            key={tracked?.id ?? "global"}
            title={
              tracked ? `Live position for MMSI ${tracked.vessel_mmsi}` : "Live vessel traffic"
            }
            src={tracked?.vessel_mmsi ? vesselEmbed(tracked.vessel_mmsi) : GLOBAL_EMBED}
            className="h-[420px] w-full border-0 lg:h-[560px]"
            loading="lazy"
          />
          <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
            {tracked
              ? "If the vessel does not appear on the map: No current position data for this vessel."
              : "Vessel positions are supplied by the public MarineTraffic live map."}
          </p>
        </div>

        <ChartPanel
          id="targets"
          title="Targets"
          meta={isLoading ? null : `${active.length} active`}
        >
          {isLoading ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">Loading…</p>
          ) : active.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              No active shipments.
            </p>
          ) : (
            <ul>
              {active.map((s) => {
                const isTracked = tracked?.id === s.id;
                return (
                  <li
                    key={s.id}
                    className={`relative border-b border-sea-rule-2 py-3 pl-3 pr-1 transition-colors duration-150 ${
                      isTracked ? "bg-sea-shallows" : "hover:bg-sea-shallows/60"
                    }`}
                  >
                    {isTracked ? (
                      <span
                        aria-hidden
                        className="absolute inset-y-0 left-0 w-[2px] bg-sea-cursor"
                      />
                    ) : null}
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <Link
                          to="/shipments/$id"
                          params={{ id: s.id }}
                          className="focus-ring block truncate rounded-[1px] text-[13.5px] font-medium text-sea-ink underline-offset-2 hover:underline"
                        >
                          {s.client_name}
                          <span className="telemetry ml-2 text-[11px] font-normal text-sea-ink-3">
                            {shortId(s.id)}
                          </span>
                        </Link>
                        <p className="truncate text-xs text-muted-foreground">
                          {s.origin} → {s.destination}
                        </p>
                      </div>
                      <StatusPill status={s.status} />
                    </div>

                    {s.vessel_mmsi ? (
                      <div className="mt-2 flex items-center justify-between gap-3">
                        <span className="flex min-w-0 items-center gap-2 text-[12px]">
                          <span className="w-3.5 shrink-0">
                            <AisTarget
                              state={targetFor(s).state}
                              stopped={targetFor(s).stopped}
                              cursor={isTracked}
                              size={11}
                            />
                          </span>
                          <span className="truncate text-sea-ink-2">
                            {s.vessel_name || "Vessel"}
                          </span>
                          <span className="telemetry shrink-0 text-[11px] text-sea-ink-3">
                            {targetFor(s).reading}
                          </span>
                        </span>
                        <button
                          type="button"
                          aria-pressed={isTracked}
                          className={`focus-ring h-7 shrink-0 whitespace-nowrap rounded-[2px] px-2.5 text-[12px] font-medium ${
                            isTracked
                              ? "bg-sea-move text-sea-paper"
                              : "border border-sea-rule text-sea-ink hover:bg-sea-shallows"
                          }`}
                          onClick={() => setTracked(s)}
                        >
                          {isTracked ? "Tracking" : "Track"}
                        </button>
                      </div>
                    ) : (
                      <form
                        className="mt-2 flex items-center gap-1.5"
                        onSubmit={(e) => {
                          e.preventDefault();
                          const mmsi = (mmsiDraft[s.id] ?? "").trim();
                          if (!mmsi) return;
                          saveMmsi.mutate({ id: s.id, mmsi });
                        }}
                      >
                        <input
                          className={fieldClass}
                          placeholder="Vessel MMSI"
                          value={mmsiDraft[s.id] ?? ""}
                          onChange={(e) => setMmsiDraft({ ...mmsiDraft, [s.id]: e.target.value })}
                        />
                        <button className={btnPrimary} type="submit">
                          Save
                        </button>
                      </form>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </ChartPanel>
      </div>
    </AppShell>
  );
}
