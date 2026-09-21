import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";

import { fieldClass, useDismiss } from "@/components/AppShell";
import { searchPorts } from "@/lib/api";

/** Debounces a fast-changing value — used so typing doesn't fire a search
 * query on every keystroke against a global port reference table. */
function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

/**
 * A free-text input that also searches the global `ports` reference table
 * (now several thousand rows — see `scripts/generate-ports-migration.ts`).
 * Typing always works as a normal text field (so a destination outside the
 * reference dataset remains fully usable) — picking a suggestion
 * additionally records the structured port id, which is what enables
 * destination-aware AIS geofencing. Editing the text after a port was
 * picked clears that link, since the text no longer provably matches the
 * selected port.
 *
 * Search runs server-side (debounced, top few matches only) rather than
 * filtering a client-side copy of the whole table — the table is too large
 * for "ship every row to the browser on every shipment form" to remain the
 * right approach.
 */
export function PortAutocomplete({
  label,
  value,
  portId,
  onChange,
  placeholder,
  required,
}: {
  label: string;
  value: string;
  portId: string | null;
  onChange: (next: { text: string; portId: string | null }) => void;
  placeholder?: string;
  required?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss<HTMLLabelElement>(() => setOpen(false));
  const term = useDebounced(value.trim(), 200);

  const { data: matches = [] } = useQuery({
    queryKey: ["ports", "search", term],
    queryFn: () => searchPorts(term, 8),
    enabled: open && term.length >= 2,
  });

  return (
    <label className="relative block" ref={ref}>
      <span className="label-xs mb-1 block">{label}</span>
      <input
        className={fieldClass}
        required={required}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange({ text: e.target.value, portId: null });
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
      />
      {portId ? (
        <span className="mt-1 flex items-center gap-1 text-xs text-positive">
          <Check className="size-3" />
          Linked to a reference port
        </span>
      ) : null}
      {open && matches.length > 0 ? (
        <div className="panel-lifted animate-in absolute left-0 top-[calc(100%+2px)] z-30 w-full max-w-sm overflow-hidden p-1">
          {matches.map((p) => (
            <button
              key={p.id}
              type="button"
              className="focus-ring flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-subtle"
              onClick={() => {
                onChange({ text: p.country ? `${p.name}, ${p.country}` : p.name, portId: p.id });
                setOpen(false);
              }}
            >
              <span className="truncate font-medium">{p.name}</span>
              <span className="ml-auto shrink-0 truncate text-xs text-muted-foreground">
                {[p.country, p.unlocode].filter(Boolean).join(" · ")}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </label>
  );
}
