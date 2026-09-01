import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { AppShell } from "@/components/AppShell";
import { ShipmentTable } from "@/components/ShipmentTable";
import { listAllDocuments, listShipments } from "@/lib/api";

export const Route = createFileRoute("/shipments/active")({
  head: () => ({
    meta: [
      { title: "Active Shipments — StimTech Solutions" },
      {
        name: "description",
        content: "Every shipment still in motion — booked, in transit, at port or clearing customs.",
      },
      { property: "og:title", content: "Active Shipments — StimTech Solutions" },
      { property: "og:description", content: "Shipments that have not yet been delivered." },
    ],
  }),
  component: ActiveShipments,
});

function ActiveShipments() {
  const { data: shipments = [], isLoading } = useQuery({
    queryKey: ["shipments"],
    queryFn: listShipments,
  });
  const { data: documents = [] } = useQuery({
    queryKey: ["all-documents"],
    queryFn: listAllDocuments,
  });
  const active = shipments.filter((s) => s.status !== "Delivered");

  return (
    <AppShell
      eyebrow="Shipments"
      title="Active"
      description="Shipments that have not yet been delivered."
      wide
    >
      <ShipmentTable
        shipments={active}
        documents={documents}
        isLoading={isLoading}
        emptyTitle="No active shipments"
        emptyDescription="Every shipment on record has been delivered."
      />
    </AppShell>
  );
}
