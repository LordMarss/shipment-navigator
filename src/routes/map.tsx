import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { AppShell, Stat, btnGhost, btnPrimary, fieldClass } from "@/components/AppShell";
import { StatusPill } from "@/components/StatusPill";
import { listShipments, shortId, updateShipment, type Shipment } from "@/lib/api";

export const Route = createFileRoute("/map")({
  head: () => ({
    meta: [
      { title: "Fleet Map — StimTech Solutions" },
      {
        name: "description",
        content:
          "Live vessel traffic across Pacific shipping lanes, with per-shipment vessel tracking by MMSI.",
      },
      { property: "og:title", content: "Fleet Map — StimTech Solutions" },
      {
        property: "og:description",
        content: "Watch the vessel carrying each shipment on a live traffic map.",
      },
    ],
  }),
  component: FleetMap,
});

// MarineTraffic public embed — no API key or account required.
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

  const { data: shipments = [], isLoading } = useQuery({
    queryKey: ["shipments"],
    queryFn: listShipments,
  });
  const active = shipments.filter((s) => s.status !== "Delivered");
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
    >
      <div className="mb-8 flex flex-wrap items-start gap-x-10 gap-y-5 border-b border-border pb-6">
        <Stat label="Active Shipments" value={active.length} />
        <Stat label="Tracked by AIS" value={trackedByAis} />
        <Stat label="In Transit" value={inTransitCount} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
        <div className="panel overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
            <span className="inline-flex items-center gap-2 text-sm font-medium">
              {tracked ? (
                <span className="inline-flex size-1.5 shrink-0 rounded-full bg-primary live-pulse" aria-hidden />
              ) : null}
              {tracked
                ? `Tracking ${shortId(tracked.id)} · ${tracked.vessel_name || "vessel"} (MMSI ${tracked.vessel_mmsi})`
                : "Global traffic · Pacific Coast / North America lanes"}
            </span>
            {tracked ? <StatusPill status={tracked.status} /> : null}
          </div>
          <iframe
            key={tracked?.id ?? "global"}
            title={tracked ? `Live position for MMSI ${tracked.vessel_mmsi}` : "Live vessel traffic"}
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

        <aside className="panel overflow-hidden">
          <div className="border-b border-border px-4 py-3">
            <h2 className="label-xs">Active shipments</h2>
            <p className="mt-1 text-xs text-muted-foreground">Not yet delivered</p>
          </div>

          {isLoading ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">Loading…</p>
          ) : active.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">No active shipments.</p>
          ) : (
            <ul className="divide-y divide-border">
              {active.map((s) => {
                const isTracked = tracked?.id === s.id;
                return (
                  <li
                    key={s.id}
                    className={`border-l-2 px-4 py-3 transition-colors duration-150 ${
                      isTracked ? "border-l-primary bg-tint-selected/40" : "border-l-transparent hover:bg-subtle/60"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <Link
                          to="/shipments/$id"
                          params={{ id: s.id }}
                          className="block truncate text-sm font-medium text-primary hover:underline"
                        >
                          {shortId(s.id)} · {s.client_name}
                        </Link>
                        <p className="truncate text-xs text-muted-foreground">
                          {s.origin} → {s.destination}
                        </p>
                      </div>
                      <StatusPill status={s.status} />
                    </div>

                    {s.vessel_mmsi ? (
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <span className="text-xs text-muted-foreground">
                          {s.vessel_name || "Vessel"} · {s.vessel_mmsi}
                        </span>
                        <button
                          className={isTracked ? btnPrimary : btnGhost}
                          onClick={() => setTracked(s)}
                        >
                          {isTracked ? "Tracking" : "Track this shipment"}
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
        </aside>
      </div>
    </AppShell>
  );
}
