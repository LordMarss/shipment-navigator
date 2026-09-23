import { createFileRoute } from "@tanstack/react-router";

import { AppShell } from "@/components/AppShell";
import { VoyageBoard } from "@/components/maritime/VoyageBoard";
import { useFleet } from "@/components/maritime/useFleet";
import { useNow } from "@/components/maritime/useNow";
import type { Shipment } from "@/lib/api";

export const Route = createFileRoute("/shipments/active")({
  head: () => ({
    meta: [
      { title: "Active Shipments - StimTech Solutions" },
      {
        name: "description",
        content:
          "Every shipment still in motion - booked, in transit, at port or clearing customs.",
      },
      { property: "og:title", content: "Active Shipments - StimTech Solutions" },
      { property: "og:description", content: "Shipments that have not yet been delivered." },
    ],
  }),
  component: ActiveShipments,
});

const isActive = (s: Shipment) => s.status !== "Delivered";

function ActiveShipments() {
  const now = useNow();
  const { shipments, documents, alerts, positions, isLoading } = useFleet(isActive);

  return (
    <AppShell
      eyebrow="Shipments"
      title="Active voyages"
      description="Shipments that have not yet been delivered."
      wide
    >
      <VoyageBoard
        title="Active"
        shipments={shipments}
        documents={documents}
        alerts={alerts}
        positions={positions}
        isLoading={isLoading}
        now={now}
        showLandedCost
        emptyTitle="No active shipments"
        emptyDescription="Every shipment on record has been delivered."
      />
    </AppShell>
  );
}
