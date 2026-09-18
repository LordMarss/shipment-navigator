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

const actionBtn =
  "focus-ring rounded-md border border-border bg-surface px-2 py-1 text-xs text-foreground transition-colors hover:bg-subtle disabled:opacity-45";

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
        <h2 className="label-xs">Documents</h2>
        <span className="text-xs text-muted-foreground">
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
          <h3 className="label-xs">Other documents</h3>
          <button
            type="button"
            className={btnGhost}
            disabled={addingOther}
            onClick={() => otherInput.current?.click()}
          >
            {addingOther ? "Uploading…" : "Add file"}
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
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
          <p className="mt-2 text-xs text-muted-foreground">No additional files.</p>
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
        <div className="flex items-center gap-2 text-sm">
          <span
            aria-hidden
            className={`size-1.5 shrink-0 rounded-full ${attached ? "bg-positive" : "bg-border"}`}
          />
          <span className="truncate font-medium">{doc.name}</span>
          {attached ? (
            <span className="shrink-0 text-xs uppercase tracking-wide text-muted-foreground">
              {doc.file_type}
            </span>
          ) : null}
        </div>
        {attached ? (
          <p className="mt-0.5 truncate pl-3.5 text-xs text-muted-foreground">
            {doc.file_name} · {formatDate(doc.uploaded_at)}
          </p>
        ) : (
          <p className="mt-0.5 pl-3.5 text-xs text-muted-foreground">No file attached</p>
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
              className="focus-ring rounded-md border border-destructive/30 bg-surface px-2 py-1 text-xs text-destructive transition-colors hover:bg-risk-soft disabled:opacity-45"
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
            className="focus-ring rounded-md border border-primary bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-45"
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
