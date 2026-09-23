import { createFileRoute, Link } from "@tanstack/react-router";

import { AppShell } from "@/components/AppShell";
import { ChartPanel, ManifestMeter, Skeleton } from "@/components/maritime/marks";
import { Readouts } from "@/components/maritime/Readouts";
import { useFleet } from "@/components/maritime/useFleet";
import { STANDARD_DOCUMENTS, shortId } from "@/lib/api";

export const Route = createFileRoute("/documents")({
  head: () => ({
    meta: [
      { title: "Documents - StimTech Solutions" },
      {
        name: "description",
        content: "Document completion across every shipment: bills of lading, invoices and more.",
      },
      { property: "og:title", content: "Documents - StimTech Solutions" },
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

const SHORT: Record<string, string> = {
  "Bill of Lading": "B/L",
  "Commercial Invoice": "Invoice",
  "Certificate of Origin": "Origin cert.",
  "Packing List": "Packing list",
};

/**
 * Manifest control: for every shipment, the four standard documents as
 * cells (filled = attached, hollow = missing) with the attached file's
 * name, any additional files, and the manifest meter.
 */
function DocumentsPage() {
  const { shipments, documents, isLoading } = useFleet();

  const rows = shipments.map((s) => {
    const docs = documents.filter((d) => d.shipment_id === s.id);
    const standard = STANDARD_DOCUMENTS.map(
      (name) => docs.find((d) => d.is_standard && d.name === name) ?? null,
    );
    return {
      s,
      standard,
      attached: standard.filter((d) => d?.file_path).length,
      other: docs.filter((d) => !d.is_standard).length,
    };
  });
  const complete = rows.filter((r) => r.attached === STANDARD_DOCUMENTS.length).length;
  const missing = rows.reduce((n, r) => n + (STANDARD_DOCUMENTS.length - r.attached), 0);
  const extra = rows.reduce((n, r) => n + r.other, 0);

  return (
    <AppShell
      title="Documents"
      description="Standard document completion per shipment, plus any additional files attached."
      wide
      headerExtra={
        <Readouts
          loading={isLoading}
          items={[
            { label: "Shipments", value: shipments.length },
            { label: "Complete", value: complete },
            {
              label: "Missing docs",
              value: missing,
              ...(missing > 0 ? { tone: "caution" as const } : {}),
            },
            { label: "Other files", value: extra },
          ]}
        />
      }
    >
      <ChartPanel
        id="manifests"
        title="Manifests"
        meta={isLoading ? null : `${shipments.length} shipments`}
      >
        {isLoading ? (
          <div className="space-y-3 py-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : shipments.length === 0 ? (
          <div className="border-b border-sea-rule-2 py-10">
            <p className="text-[14px] font-medium text-sea-ink">No manifests yet</p>
            <p className="mt-1 text-[13px] text-sea-ink-2">
              Create a shipment and its four standard documents will be tracked here.
            </p>
          </div>
        ) : (
          <table className="w-full border-collapse text-left">
            <thead className="max-lg:hidden">
              <tr className="shadow-[inset_0_-1px_0_var(--sea-rule)]">
                <th scope="col" className="label-xs py-2 pr-6 font-normal">
                  Shipment
                </th>
                {STANDARD_DOCUMENTS.map((name) => (
                  <th
                    key={name}
                    scope="col"
                    className="label-xs py-2 pr-5 font-normal"
                    title={name}
                  >
                    {SHORT[name] ?? name}
                  </th>
                ))}
                <th scope="col" className="label-xs py-2 pr-5 font-normal">
                  Other
                </th>
                <th scope="col" className="label-xs py-2 font-normal">
                  Manifest
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ s, standard, attached, other }) => (
                <tr
                  key={s.id}
                  className="border-b border-sea-rule-2 align-top max-lg:grid max-lg:gap-2 max-lg:py-3.5"
                >
                  <td className="py-3.5 pr-6 max-lg:py-0 lg:w-[24%]">
                    <Link
                      to="/shipments/$id"
                      params={{ id: s.id }}
                      className="focus-ring block truncate rounded-[1px] text-[14px] font-medium text-sea-ink underline-offset-2 hover:underline"
                    >
                      {s.client_name}
                    </Link>
                    <span className="ref-tag mt-1">{shortId(s.id)}</span>
                  </td>
                  {standard.map((d, i) => {
                    const name = STANDARD_DOCUMENTS[i]!;
                    return (
                      <td key={name} className="py-3.5 pr-5 max-lg:py-0">
                        <span className="flex min-w-0 items-center gap-2 text-[12px]" title={name}>
                          <span
                            aria-hidden
                            className={`inline-block h-[10px] w-[7px] shrink-0 ${
                              d?.file_path ? "bg-sea-green" : "border border-sea-ink-4"
                            }`}
                          />
                          <span className="label-xs shrink-0 !text-[9.5px] lg:hidden">
                            {SHORT[name] ?? name}
                          </span>
                          {d?.file_path ? (
                            <span className="max-w-[150px] truncate text-sea-ink-2">
                              {d.file_name ?? "Attached"}
                            </span>
                          ) : (
                            <span className="text-sea-ink-4">Missing</span>
                          )}
                        </span>
                      </td>
                    );
                  })}
                  <td className="telemetry py-3.5 pr-5 text-[11.5px] text-sea-ink-3 max-lg:py-0">
                    {other > 0 ? `${other} file${other === 1 ? "" : "s"}` : "None"}
                  </td>
                  <td className="py-3.5 text-[12px] max-lg:py-0">
                    <ManifestMeter attached={attached} total={STANDARD_DOCUMENTS.length} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </ChartPanel>
    </AppShell>
  );
}
