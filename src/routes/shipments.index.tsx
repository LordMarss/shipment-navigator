import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Plus } from "lucide-react";

import { AppShell, btnPrimary } from "@/components/AppShell";
import { NewShipmentForm } from "@/components/NewShipmentForm";
import { VoyageBoard } from "@/components/maritime/VoyageBoard";
import { useFleet } from "@/components/maritime/useFleet";
import { useNow } from "@/components/maritime/useNow";
import { ShipmentBookTabs } from "@/components/maritime/ShipmentBookTabs";

export const Route = createFileRoute("/shipments/")({
  head: () => ({
    meta: [
      { title: "All Shipments - StimTech Solutions" },
      {
        name: "description",
        content:
          "Every shipment in one operations table: client, route, vessel, ETA, status, documents and landed cost.",
      },
      { property: "og:title", content: "All Shipments - StimTech Solutions" },
      {
        property: "og:description",
        content: "Search, filter and sort your full shipment book.",
      },
    ],
  }),
  component: AllShipments,
});

function AllShipments() {
  const [open, setOpen] = useState(false);
  const now = useNow();
  const { shipments, documents, alerts, positions, isLoading } = useFleet();

  return (
    <AppShell
      title="Shipments"
      wide
      tabs={<ShipmentBookTabs />}
      actions={
        <button className={btnPrimary} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <Plus className="size-3.5" />
          {open ? "Close form" : "New shipment"}
        </button>
      }
    >
      {open ? (
        <div className="mb-8">
          <NewShipmentForm onClose={() => setOpen(false)} />
        </div>
      ) : null}
      <VoyageBoard
        title="Shipment board"
        shipments={shipments}
        documents={documents}
        alerts={alerts}
        positions={positions}
        isLoading={isLoading}
        now={now}
        showLandedCost
        emptyTitle="No shipments yet"
        emptyDescription="Create your first shipment to start tracking documents, vessels and landed cost."
        emptyAction={
          <button className={btnPrimary} onClick={() => setOpen(true)}>
            <Plus className="size-3.5" /> New shipment
          </button>
        }
      />
    </AppShell>
  );
}
