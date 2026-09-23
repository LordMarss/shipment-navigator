import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { AppShell } from "@/components/AppShell";
import { ChartPanel } from "@/components/maritime/marks";
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
      { title: "Settings - StimTech Solutions" },
      {
        name: "description",
        content: "Workspace configuration: document standards, upload limits and data summary.",
      },
      { property: "og:title", content: "Settings - StimTech Solutions" },
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
      title="Settings"
      description="Configuration for this single-user operations workspace."
    >
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 lg:grid-cols-2">
        <ChartPanel id="workspace" title="Workspace">
          <Row label="Company" value="StimTech Solutions" />
          <Row label="Mode" value="Single-user (no sign-in required)" />
          <Row label="Shipments stored" value={String(shipments.length)} />
          <Row label="Documents stored" value={String(documents.length)} />
        </ChartPanel>

        <ChartPanel id="policy" title="Document policy">
          <Row label="Max file size" value={formatBytes(MAX_FILE_BYTES)} />
          <Row label="Accepted types" value="PDF, JPG, PNG" />
          <Row label="Storage access" value="Private, signed links only" />
          <Row label="Raw accept list" value={ACCEPTED_FILE_TYPES} mono />
        </ChartPanel>

        <ChartPanel
          id="standard-docs"
          title="Standard documents"
          meta="created with every shipment"
          className="lg:col-span-2"
        >
          <ul className="grid gap-x-8 py-2 sm:grid-cols-2 lg:grid-cols-4">
            {STANDARD_DOCUMENTS.map((name, i) => (
              <li
                key={name}
                className="flex items-center gap-2.5 border-b border-sea-rule-2 py-2.5 text-[13.5px] text-sea-ink sm:border-b-0"
              >
                <span className="telemetry text-[10.5px] text-sea-ink-4">
                  {String(i + 1).padStart(2, "0")}
                </span>
                {name}
              </li>
            ))}
          </ul>
        </ChartPanel>
      </div>
    </AppShell>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 border-t border-sea-rule-2 py-3 text-[13.5px] first-of-type:border-t-0">
      <span className="shrink-0 text-sea-ink-3">{label}</span>
      <span
        className={`min-w-0 max-w-[60%] truncate text-right ${mono ? "telemetry text-[11px] text-sea-ink-2" : "font-medium text-sea-ink"}`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}
