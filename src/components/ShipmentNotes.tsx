import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { btnGhost, btnPrimary, fieldClass } from "@/components/AppShell";
import { utcDayTime } from "@/components/maritime/format";
import { createNote, deleteNote, listNotes, updateNote, type ShipmentNote } from "@/lib/api";

/**
 * The operations log: operator notes on this voyage, newest first, each
 * stamped in UTC with its author, set as log lines rather than cards.
 * Separate from the automated voyage log in `shipment_events`. Backed by
 * the existing `shipment_notes` table/API.
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
    <section
      aria-labelledby="ops-log-title"
      className="panel min-w-0 px-4 pb-3 sm:px-5 [&_li:last-child]:border-b-0"
    >
      <div className="-mx-4 flex min-h-[52px] items-center justify-between border-b border-sea-rule px-4 py-2.5 sm:-mx-5 sm:px-5">
        <h2 id="ops-log-title" className="panel-title">
          Operations log
          <span className="telemetry ml-2 font-normal normal-case tracking-normal text-sea-ink-3">
            {isLoading ? "" : `${notes.length} ${notes.length === 1 ? "entry" : "entries"}, UTC`}
          </span>
        </h2>
      </div>

      <form
        className="flex flex-col gap-2 border-b border-sea-rule py-3 sm:flex-row sm:items-start"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) add.mutate();
        }}
      >
        <label className="min-w-0 flex-1">
          <span className="sr-only">New log entry</span>
          <textarea
            className={`${fieldClass} min-h-[36px] resize-y py-1.5`}
            rows={1}
            placeholder="Log an entry: calls made, client updates, instructions for the next watch"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && draft.trim()) {
                e.preventDefault();
                add.mutate();
              }
            }}
          />
        </label>
        <button
          type="submit"
          className={`${btnPrimary} self-end sm:self-start`}
          disabled={add.isPending || !draft.trim()}
        >
          {add.isPending ? "Logging…" : "Log entry"}
        </button>
      </form>

      {isLoading ? (
        <p className="py-4 text-[12.5px] text-sea-ink-3">Loading the log…</p>
      ) : notes.length === 0 ? (
        <div className="py-5">
          <p className="text-[13px] font-medium text-sea-ink">No entries yet</p>
          <p className="mt-1 max-w-[60ch] text-[12.5px] text-sea-ink-2">
            Anything the next person on watch should know about this voyage belongs here. Entries
            are timestamped and kept with the record.
          </p>
        </div>
      ) : (
        <ol>
          {notes.map((n) => (
            <NoteRow key={n.id} note={n} onChanged={invalidate} />
          ))}
        </ol>
      )}
    </section>
  );
}

function NoteRow({ note, onChanged }: { note: ShipmentNote; onChanged: () => void }) {
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
    <li className="group animate-in grid grid-cols-1 gap-x-4 gap-y-1 border-b border-sea-rule-2 py-3 sm:grid-cols-[120px_minmax(0,1fr)]">
      <div className="telemetry flex gap-3 text-[10.5px] uppercase text-sea-ink-3 sm:block">
        <time dateTime={note.created_at} className="block text-sea-ink-2">
          {utcDayTime(note.created_at)}
        </time>
        <span className="block">
          {note.author ?? "Operator"}
          {note.updated_at !== note.created_at ? ", edited" : ""}
        </span>
      </div>
      {editing ? (
        <div className="flex flex-col gap-2">
          <textarea
            className={`${fieldClass} min-h-[64px] resize-y py-1.5`}
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
        <div className="flex min-w-0 items-start justify-between gap-4">
          <p className="whitespace-pre-wrap text-[13.5px] leading-[1.5] text-sea-ink">
            {note.body}
          </p>
          <span className="flex shrink-0 gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100">
            <button
              type="button"
              className="focus-ring h-7 rounded-md px-2 text-[12px] text-sea-ink-3 hover:bg-sea-paper-2 hover:text-sea-ink"
              onClick={() => setEditing(true)}
            >
              Edit
            </button>
            <button
              type="button"
              className="focus-ring h-7 rounded-md px-2 text-[12px] text-sea-ink-3 hover:bg-sea-red-soft hover:text-sea-red"
              disabled={remove.isPending}
              onClick={() => {
                if (confirm("Delete this log entry?")) remove.mutate();
              }}
            >
              Delete
            </button>
          </span>
        </div>
      )}
    </li>
  );
}
