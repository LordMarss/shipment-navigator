import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { btnGhost } from "@/components/AppShell";
import {
  ACCEPTED_FILE_TYPES,
  clearDocumentFile,
  createOtherDocument,
  deleteDocument,
  formatDate,
  getDocumentUrl,
  uploadDocumentFile,
  type ShipmentDocument,
} from "@/lib/api";

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
    <div className="panel p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[13px] font-semibold">Documents</h2>
        <span className="text-[12px] text-muted-foreground">
          {doneCount}/{standard.length} attached
        </span>
      </div>

      <ul className="divide-y divide-border border-t border-border">
        {standard.map((doc) => (
          <DocumentRow key={doc.id} doc={doc} onChanged={invalidate} />
        ))}
      </ul>

      <div className="mt-4 border-t border-border pt-3">
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-[13px] font-semibold">Other documents</h3>
          <button
            type="button"
            className={btnGhost}
            disabled={addingOther}
            onClick={() => otherInput.current?.click()}
          >
            {addingOther ? "Uploading…" : "Add file"}
          </button>
        </div>
        <p className="text-[12px] text-muted-foreground">
          Customs notices, photos, email confirmations — PDF, JPG or PNG up to 10 MB.
        </p>
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
        {others.length > 0 ? (
          <ul className="mt-2 divide-y divide-border border-t border-border">
            {others.map((doc) => (
              <DocumentRow key={doc.id} doc={doc} onChanged={invalidate} freeform />
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-[12px] text-muted-foreground">No additional files.</p>
        )}
      </div>
    </div>
  );
}

function DocumentRow({
  doc,
  onChanged,
  freeform = false,
}: {
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
    <li className="flex items-start justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-[13px]">
          <span
            aria-hidden
            className={`size-1.5 shrink-0 rounded-full ${attached ? "bg-positive" : "bg-border"}`}
          />
          <span className="truncate font-medium">{doc.name}</span>
          {attached ? (
            <span className="shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">
              {doc.file_type}
            </span>
          ) : null}
        </div>
        {attached ? (
          <p className="mt-0.5 truncate pl-3.5 text-[12px] text-muted-foreground">
            {doc.file_name} · {formatDate(doc.uploaded_at)}
          </p>
        ) : (
          <p className="mt-0.5 pl-3.5 text-[12px] text-muted-foreground">No file attached</p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
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
        {attached ? (
          <>
            <button
              type="button"
              className="focus-ring rounded-sm border border-border bg-surface px-1.5 py-1 text-[12px] text-foreground hover:bg-subtle"
              title="View or download"
              onClick={open}
            >
              View
            </button>
            <button
              type="button"
              className="focus-ring rounded-sm border border-border bg-surface px-1.5 py-1 text-[12px] text-foreground hover:bg-subtle disabled:opacity-45"
              disabled={busy}
              onClick={() => input.current?.click()}
            >
              Replace
            </button>
            <button
              type="button"
              className="focus-ring rounded-sm border border-destructive/30 bg-surface px-1.5 py-1 text-[12px] text-destructive hover:bg-risk-soft disabled:opacity-45"
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
            className="focus-ring rounded-sm border border-primary bg-primary px-2 py-1 text-[12px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-45"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            {busy ? "Uploading…" : "Upload"}
          </button>
        )}
      </div>
    </li>
  );
}
