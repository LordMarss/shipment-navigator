import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { AppShell } from "@/components/AppShell";
import {
  ACCEPTED_FILE_TYPES,
  MAX_FILE_BYTES,
  STANDARD_DOCUMENTS,
  formatBytes,
  listAllDocuments,
  listShipments,
} from "@/lib/api";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings — StimTech Solutions" },
      {
        name: "description",
        content: "Workspace configuration: document standards, upload limits and data summary.",
      },
      { property: "og:title", content: "Settings — StimTech Solutions" },
      {
        property: "og:description",
        content: "Workspace configuration for your logistics operations.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: SettingsPage,
});

function SettingsPage() {
  const { data: shipments = [] } = useQuery({ queryKey: ["shipments"], queryFn: listShipments });
  const { data: documents = [] } = useQuery({
    queryKey: ["all-documents"],
    queryFn: listAllDocuments,
  });

  return (
    <AppShell
      eyebrow="Workspace"
      title="Settings"
      description="Configuration for this single-user operations workspace."
    >
      <div className="grid gap-x-10 gap-y-8 lg:grid-cols-2">
        <section>
          <h2 className="label-xs mb-1">Workspace</h2>
          <Row label="Company" value="StimTech Solutions" />
          <Row label="Mode" value="Single-user (no sign-in required)" />
          <Row label="Shipments stored" value={String(shipments.length)} />
          <Row label="Documents stored" value={String(documents.length)} />
        </section>

        <section>
          <h2 className="label-xs mb-1">Document policy</h2>
          <Row label="Max file size" value={formatBytes(MAX_FILE_BYTES)} />
          <Row label="Accepted types" value="PDF, JPG, PNG" />
          <Row label="Storage access" value="Private — signed links only" />
          <Row label="Raw accept list" value={ACCEPTED_FILE_TYPES} />
        </section>

        <section className="lg:col-span-2">
          <h2 className="label-xs mb-2">Standard documents auto-created per shipment</h2>
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {STANDARD_DOCUMENTS.map((name) => (
              <li key={name} className="flex items-center gap-2 text-sm">
                <span className="size-1.5 rounded-full bg-primary/70" />
                {name}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </AppShell>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 border-t border-border py-2.5 text-sm first-of-type:border-t-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="max-w-[60%] truncate text-right font-medium">{value}</span>
    </div>
  );
}
