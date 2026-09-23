import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { ManifestMeter } from "@/components/maritime/marks";
import { utcDayTime } from "@/components/maritime/format";
import {
  ACCEPTED_FILE_TYPES,
  clearDocumentFile,
  createOtherDocument,
  deleteDocument,
  getDocumentUrl,
  STANDARD_DOCUMENTS,
  uploadDocumentFile,
  type ShipmentDocument,
} from "@/lib/api";

const actionBtn =
  "focus-ring h-7 rounded-[2px] px-2 text-[12px] text-sea-ink-2 transition-colors hover:bg-sea-paper-2 hover:text-sea-ink disabled:opacity-45";

/**
 * The documentation manifest: the required trade documents as numbered
 * lines, each with its file, when it was lodged and what to do next, then
 * any supporting files. Missing required documents lead the eye; attached
 * ones recede.
 */
export function DocumentFiles({
  shipmentId,
  documents,
}: {
  shipmentId: string;
  documents: ShipmentDocument[];
}) {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["documents", shipmentId] });

  const standard = documents.filter((d) => d.is_standard);
  const others = documents.filter((d) => !d.is_standard);
  const doneCount = standard.filter((d) => d.file_path).length;
  // A record created without its document lines still owes the standard
  // set (health counts them missing), so the manifest lists them as such.
  const unlisted = standard.length === 0;
  const missing = unlisted ? STANDARD_DOCUMENTS.length : standard.length - doneCount;

  const otherInput = useRef<HTMLInputElement | null>(null);
  const [addingOther, setAddingOther] = useState(false);

  const addOther = useMutation({
    mutationFn: (file: File) => createOtherDocument(shipmentId, file),
    onSuccess: () => {
      invalidate();
      toast.success("File uploaded");
    },
    onError: (e: Error) => toast.error(e.message),
    onSettled: () => setAddingOther(false),
  });

  return (
    <section aria-labelledby="manifest-title">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 border-b border-sea-ink pb-2">
        <h2 id="manifest-title" className="chart-label text-sea-ink">
          Documentation manifest
        </h2>
        <span className="flex items-center gap-3 text-[12px]">
          <ManifestMeter attached={doneCount} total={standard.length || 4} />
          <span className={missing > 0 ? "text-sea-amber-ink" : "text-sea-ink-3"}>
            {missing > 0
              ? `${missing} required document${missing === 1 ? "" : "s"} outstanding`
              : "All required documents lodged"}
          </span>
        </span>
      </div>

      <table className="w-full text-left">
        <thead className="sr-only sm:table-header-group sm:not-sr-only">
          <tr className="border-b border-sea-rule">
            <th className="chart-label w-8 py-2 font-normal text-sea-ink-3">No</th>
            <th className="chart-label py-2 font-normal text-sea-ink-3">Document</th>
            <th className="chart-label hidden py-2 font-normal text-sea-ink-3 md:table-cell">
              File
            </th>
            <th className="chart-label hidden py-2 font-normal text-sea-ink-3 sm:table-cell">
              Lodged (UTC)
            </th>
            <th className="py-2">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {standard.map((doc, i) => (
            <DocumentRow key={doc.id} index={i + 1} doc={doc} onChanged={invalidate} />
          ))}
          {unlisted
            ? STANDARD_DOCUMENTS.map((name, i) => (
                <tr key={name} className="border-b border-sea-rule-2 align-middle">
                  <td className="telemetry w-8 py-2.5 text-[10.5px] text-sea-ink-4">
                    {String(i + 1).padStart(2, "0")}
                  </td>
                  <td className="py-2.5 pr-3">
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className="inline-block h-[10px] w-[4px] shrink-0 border border-sea-amber-ink"
                      />
                      <span className="truncate text-[13.5px] font-medium text-sea-ink">
                        {name}
                      </span>
                    </span>
                  </td>
                  <td colSpan={3} className="py-2.5 text-[12px] text-sea-amber-ink max-sm:hidden">
                    Outstanding
                  </td>
                </tr>
              ))
            : null}
          {unlisted ? (
            <tr>
              <td />
              <td colSpan={4} className="py-3 text-[12.5px] leading-[1.5] text-sea-ink-3">
                This record has no document lines to lodge against. File these as supporting files
                below.
              </td>
            </tr>
          ) : null}
          <tr className="border-b border-sea-rule">
            <th colSpan={5} scope="rowgroup" className="pb-2 pt-8 text-left font-normal">
              <span className="flex flex-wrap items-end justify-between gap-3">
                <span>
                  <span className="chart-label block text-sea-ink">Supporting files</span>
                  <span className="mt-0.5 block text-[12px] text-sea-ink-3">
                    Customs notices, survey photos, email confirmations. PDF, JPG or PNG up to 10
                    MB.
                  </span>
                </span>
                <button
                  type="button"
                  className="focus-ring inline-flex h-8 items-center rounded-[2px] border border-sea-rule bg-sea-surface px-3 text-[13px] font-medium text-sea-ink hover:bg-sea-paper-2 disabled:opacity-45"
                  disabled={addingOther}
                  onClick={() => otherInput.current?.click()}
                >
                  {addingOther ? "Uploading…" : "Add file"}
                </button>
              </span>
            </th>
          </tr>
          {others.length > 0 ? (
            others.map((doc, i) => (
              <DocumentRow
                key={doc.id}
                index={standard.length + i + 1}
                doc={doc}
                onChanged={invalidate}
                freeform
              />
            ))
          ) : (
            <tr>
              <td />
              <td colSpan={4} className="py-3 text-[12.5px] text-sea-ink-3">
                None filed.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <input
        ref={otherInput}
        type="file"
        accept={ACCEPTED_FILE_TYPES}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          setAddingOther(true);
          addOther.mutate(file);
        }}
      />
    </section>
  );
}

function DocumentRow({
  index,
  doc,
  onChanged,
  freeform = false,
}: {
  index: number;
  doc: ShipmentDocument;
  onChanged: () => void;
  freeform?: boolean;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try {
      await fn();
      onChanged();
      toast.success(success);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const open = async () => {
    try {
      const url = await getDocumentUrl(doc);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const attached = Boolean(doc.file_path);

  return (
    <tr className="border-b border-sea-rule-2 align-middle">
      <td className="telemetry w-8 py-2.5 text-[10.5px] text-sea-ink-4">
        {String(index).padStart(2, "0")}
      </td>
      <td className="py-2.5 pr-3">
        <span className="flex items-center gap-2">
          <span
            aria-hidden
            className={`inline-block h-[10px] w-[4px] shrink-0 ${
              attached ? "bg-sea-green" : "border border-sea-amber-ink bg-transparent"
            }`}
          />
          <span
            className={`truncate text-[13.5px] ${attached ? "text-sea-ink" : "font-medium text-sea-ink"}`}
          >
            {doc.name}
          </span>
        </span>
        <span className="telemetry mt-0.5 block truncate pl-3 text-[10.5px] uppercase text-sea-ink-3 md:hidden">
          {attached ? doc.file_name : "Outstanding"}
        </span>
      </td>
      <td className="hidden py-2.5 pr-3 md:table-cell">
        {attached ? (
          <span className="flex min-w-0 items-center gap-2 text-[12.5px] text-sea-ink-2">
            <span className="truncate">{doc.file_name}</span>
            {doc.file_type ? (
              <span className="telemetry shrink-0 text-[10px] uppercase text-sea-ink-4">
                {doc.file_type.split("/").pop()}
              </span>
            ) : null}
          </span>
        ) : (
          <span className="telemetry text-[10.5px] uppercase text-sea-amber-ink">Outstanding</span>
        )}
      </td>
      <td className="telemetry hidden py-2.5 pr-3 text-[11px] uppercase text-sea-ink-3 sm:table-cell">
        {attached && doc.uploaded_at ? utcDayTime(doc.uploaded_at) : ""}
      </td>
      <td className="py-2.5 text-right">
        <input
          ref={input}
          type="file"
          accept={ACCEPTED_FILE_TYPES}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            void run(() => uploadDocumentFile(doc, file), "File uploaded");
          }}
        />
        <span className="inline-flex items-center gap-0.5 whitespace-nowrap">
          {attached ? (
            <>
              <button type="button" className={actionBtn} title="View or download" onClick={open}>
                View
              </button>
              <button
                type="button"
                className={actionBtn}
                disabled={busy}
                onClick={() => input.current?.click()}
              >
                Replace
              </button>
              <button
                type="button"
                className="focus-ring h-7 rounded-[2px] px-2 text-[12px] text-sea-red transition-colors hover:bg-sea-red-soft disabled:opacity-45"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => (freeform ? deleteDocument(doc) : clearDocumentFile(doc)),
                    "File removed",
                  )
                }
              >
                Remove
              </button>
            </>
          ) : (
            <button
              type="button"
              className="focus-ring inline-flex h-7 items-center rounded-[2px] bg-sea-ink px-2.5 text-[12px] font-medium text-sea-surface transition-colors hover:bg-sea-ink-2 disabled:opacity-45"
              disabled={busy}
              onClick={() => input.current?.click()}
            >
              {busy ? "Uploading…" : "Upload"}
            </button>
          )}
        </span>
      </td>
    </tr>
  );
}
