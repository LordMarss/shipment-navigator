import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { btnGhost, btnPrimary, fieldClass } from "@/components/AppShell";
import { createNote, deleteNote, listNotes, updateNote, type ShipmentNote } from "@/lib/api";
import { formatDayTime } from "@/lib/lifecycle";

/**
 * Manual annotations on a shipment, separate from the automated audit trail
 * in `shipment_events`. Backed by the existing `shipment_notes` table/API —
 * this wires up UI for functionality the backend already supports.
 */
export function ShipmentNotes({ shipmentId }: { shipmentId: string }) {
  const queryClient = useQueryClient();
  const { data: notes = [], isLoading } = useQuery({
    queryKey: ["notes", shipmentId],
    queryFn: () => listNotes(shipmentId),
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["notes", shipmentId] });

  const [draft, setDraft] = useState("");
  const add = useMutation({
    mutationFn: () => createNote(shipmentId, draft),
    onSuccess: () => {
      setDraft("");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="panel p-4">
      <h2 className="mb-3 text-[13px] font-semibold">Notes</h2>

      <form
        className="mb-4 flex flex-col gap-2 border-b border-border pb-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) add.mutate();
        }}
      >
        <textarea
          className={`${fieldClass} min-h-[72px] resize-y`}
          placeholder="Add a note about this shipment..."
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          type="submit"
          className={`${btnPrimary} self-end`}
          disabled={add.isPending || !draft.trim()}
        >
          {add.isPending ? "Adding…" : "Add note"}
        </button>
      </form>

      {isLoading ? (
        <p className="text-[12px] text-muted-foreground">Loading notes…</p>
      ) : notes.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">No notes yet.</p>
      ) : (
        <ul className="space-y-3">
          {notes.map((n) => (
            <NoteRow key={n.id} note={n} onChanged={invalidate} />
          ))}
        </ul>
      )}
    </div>
  );
}

function NoteRow({
  note,
  onChanged,
}: {
  note: ShipmentNote;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.body);

  const save = useMutation({
    mutationFn: () => updateNote(note.id, text),
    onSuccess: () => {
      setEditing(false);
      onChanged();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: () => deleteNote(note.id),
    onSuccess: onChanged,
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <li className="rounded-sm border border-border bg-subtle/40 p-3">
      <div className="mb-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{note.author ?? "Operator"}</span>
        <span>
          {formatDayTime(note.created_at)}
          {note.updated_at !== note.created_at ? " · edited" : ""}
        </span>
      </div>
      {editing ? (
        <div className="flex flex-col gap-2">
          <textarea
            className={`${fieldClass} min-h-[64px] resize-y`}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              className={btnGhost}
              onClick={() => {
                setText(note.body);
                setEditing(false);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className={btnPrimary}
              disabled={save.isPending || !text.trim()}
              onClick={() => save.mutate()}
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="whitespace-pre-wrap text-[13px] text-foreground">{note.body}</p>
          <div className="mt-1.5 flex justify-end gap-1.5">
            <button
              type="button"
              className="text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() => setEditing(true)}
            >
              Edit
            </button>
            <button
              type="button"
              className="text-[11px] text-muted-foreground hover:text-destructive"
              disabled={remove.isPending}
              onClick={() => {
                if (confirm("Delete this note?")) remove.mutate();
              }}
            >
              Delete
            </button>
          </div>
        </>
      )}
    </li>
  );
}
