import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Plus } from "lucide-react";

import { AppShell, btnPrimary } from "@/components/AppShell";
import { NewShipmentForm } from "@/components/NewShipmentForm";
import { ShipmentTable } from "@/components/ShipmentTable";
import { listAllDocuments, listShipments } from "@/lib/api";

export const Route = createFileRoute("/shipments/")({
  head: () => ({
    meta: [
      { title: "All Shipments — StimTech Solutions" },
      {
        name: "description",
        content:
          "Every shipment in one operations table: client, route, vessel, ETA, status, documents and landed cost.",
      },
      { property: "og:title", content: "All Shipments — StimTech Solutions" },
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
  const { data: shipments = [], isLoading } = useQuery({
    queryKey: ["shipments"],
    queryFn: listShipments,
  });
  const { data: documents = [] } = useQuery({
    queryKey: ["all-documents"],
    queryFn: listAllDocuments,
  });

  return (
    <AppShell
      eyebrow="Shipments"
      title="All shipments"
      description={`${shipments.length} shipment${shipments.length === 1 ? "" : "s"} on record`}
      wide
      actions={
        <button className={btnPrimary} onClick={() => setOpen((v) => !v)}>
          <Plus className="size-3.5" />
          {open ? "Close form" : "New shipment"}
        </button>
      }
    >
      {open ? <NewShipmentForm onClose={() => setOpen(false)} /> : null}
      <ShipmentTable
        shipments={shipments}
        documents={documents}
        isLoading={isLoading}
        emptyAction={
          <button className={btnPrimary} onClick={() => setOpen(true)}>
            <Plus className="size-3.5" /> New shipment
          </button>
        }
      />
    </AppShell>
  );
}
