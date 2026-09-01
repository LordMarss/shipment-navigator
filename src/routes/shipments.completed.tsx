import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { AppShell } from "@/components/AppShell";
import { ShipmentTable } from "@/components/ShipmentTable";
import { listAllDocuments, listShipments } from "@/lib/api";

export const Route = createFileRoute("/shipments/completed")({
  head: () => ({
    meta: [
      { title: "Completed Shipments — StimTech Solutions" },
      {
        name: "description",
        content: "Delivered shipments with their final landed cost and document record.",
      },
      { property: "og:title", content: "Completed Shipments — StimTech Solutions" },
      { property: "og:description", content: "Your delivered shipment history." },
    ],
  }),
  component: CompletedShipments,
});

function CompletedShipments() {
  const { data: shipments = [], isLoading } = useQuery({
    queryKey: ["shipments"],
    queryFn: listShipments,
  });
  const { data: documents = [] } = useQuery({
    queryKey: ["all-documents"],
    queryFn: listAllDocuments,
  });
  const done = shipments.filter((s) => s.status === "Delivered");

  return (
    <AppShell
      eyebrow="Shipments"
      title="Completed"
      description="Delivered shipments and their final record."
      wide
    >
      <ShipmentTable
        shipments={done}
        documents={documents}
        isLoading={isLoading}
        emptyTitle="Nothing delivered yet"
        emptyDescription="Shipments appear here once their status reaches Delivered."
      />
    </AppShell>
  );
}
