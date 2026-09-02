import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { AppShell, EmptyState, Skeleton } from "@/components/AppShell";
import { DocsIndicator } from "@/components/StatusPill";
import { STANDARD_DOCUMENTS, listAllDocuments, listShipments, shortId } from "@/lib/api";

export const Route = createFileRoute("/documents")({
  head: () => ({
    meta: [
      { title: "Documents — StimTech Solutions" },
      {
        name: "description",
        content: "Document completion across every shipment: bills of lading, invoices and more.",
      },
      { property: "og:title", content: "Documents — StimTech Solutions" },
      {
        property: "og:description",
        content: "Track which shipment documents are still missing.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: DocumentsPage,
});

function DocumentsPage() {
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
      eyebrow="Documents"
      title="Document Control"
      description="Standard document completion per shipment, plus any additional files attached."
      wide
    >
      {isLoading ? (
        <div className="panel space-y-2 p-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : shipments.length === 0 ? (
        <div className="panel">
          <EmptyState
            title="No documents yet"
            description="Create a shipment and its four standard documents will be tracked here."
          />
        </div>
      ) : (
        <div className="panel overflow-x-auto">
          <table className="w-full min-w-[860px] border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="label-xs px-3 py-2">Shipment</th>
                <th className="label-xs px-3 py-2">Client</th>
                {STANDARD_DOCUMENTS.map((name) => (
                  <th key={name} className="label-xs px-3 py-2">
                    {name}
                  </th>
                ))}
                <th className="label-xs px-3 py-2">Other</th>
                <th className="label-xs px-3 py-2">Complete</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {shipments.map((s) => {
                const docs = documents.filter((d) => d.shipment_id === s.id);
                const standard = STANDARD_DOCUMENTS.map(
                  (name) => docs.find((d) => d.is_standard && d.name === name) ?? null,
                );
                const attached = standard.filter((d) => d?.file_path).length;
                const other = docs.filter((d) => !d.is_standard).length;
                return (
                  <tr key={s.id} className="transition-colors hover:bg-subtle/60">
                    <td className="px-3 py-2">
                      <Link
                        to="/shipments/$id"
                        params={{ id: s.id }}
                        className="font-mono text-[12px] text-primary hover:underline"
                      >
                        {shortId(s.id)}
                      </Link>
                    </td>
                    <td className="px-3 py-2 font-medium">{s.client_name}</td>
                    {standard.map((d, i) => (
                      <td key={i} className="px-3 py-2">
                        {d?.file_path ? (
                          <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
                            <span className="size-1.5 rounded-full bg-positive" />
                            <span className="max-w-[140px] truncate">{d.file_name}</span>
                          </span>
                        ) : (
                          <span className="text-[12px] text-muted-foreground/60">Missing</span>
                        )}
                      </td>
                    ))}
                    <td className="px-3 py-2 text-[12px] text-muted-foreground">
                      {other > 0 ? `${other} file${other === 1 ? "" : "s"}` : "—"}
                    </td>
                    <td className="px-3 py-2">
                      <DocsIndicator attached={attached} total={STANDARD_DOCUMENTS.length} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </AppShell>
  );
}
