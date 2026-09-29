import { createFileRoute } from "@tanstack/react-router";

import { AppShell } from "@/components/AppShell";
import { VoyageBoard } from "@/components/maritime/VoyageBoard";
import { useFleet } from "@/components/maritime/useFleet";
import { useNow } from "@/components/maritime/useNow";
import { ShipmentBookTabs } from "@/components/maritime/ShipmentBookTabs";
import type { Shipment } from "@/lib/api";

export const Route = createFileRoute("/shipments/completed")({
  head: () => ({
    meta: [
      { title: "Completed Shipments - StimTech Solutions" },
      {
        name: "description",
        content: "Delivered shipments with their final landed cost and document record.",
      },
      { property: "og:title", content: "Completed Shipments - StimTech Solutions" },
      { property: "og:description", content: "Your delivered shipment history." },
    ],
  }),
  component: CompletedShipments,
});

const isDone = (s: Shipment) => s.status === "Delivered";

function CompletedShipments() {
  const now = useNow();
  const { shipments, documents, alerts, positions, isLoading } = useFleet(isDone);

  return (
    <AppShell title="Shipments" wide tabs={<ShipmentBookTabs />}>
      <VoyageBoard
        title="Shipment board"
        shipments={shipments}
        documents={documents}
        alerts={alerts}
        positions={positions}
        isLoading={isLoading}
        now={now}
        showLandedCost
        emptyTitle="Nothing delivered yet"
        emptyDescription="Shipments appear here once their status reaches Delivered."
      />
    </AppShell>
  );
}
