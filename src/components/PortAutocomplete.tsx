import { useState } from "react";
import { Check } from "lucide-react";

import { fieldClass, useDismiss } from "@/components/AppShell";
import type { Port } from "@/lib/api";

/**
 * A free-text input that also searches the seeded `ports` table. Typing
 * always works as a normal text field (so ports outside the seed dataset
 * remain fully usable) — picking a suggestion additionally records the
 * structured port id, which is what enables destination-aware AIS
 * geofencing. Editing the text after a port was picked clears that link,
 * since the text no longer provably matches the selected port.
 */
export function PortAutocomplete({
  label,
  value,
  portId,
  ports,
  onChange,
  placeholder,
  required,
}: {
  label: string;
  value: string;
  portId: string | null;
  ports: Port[];
  onChange: (next: { text: string; portId: string | null }) => void;
  placeholder?: string;
  required?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss<HTMLLabelElement>(() => setOpen(false));

  const term = value.trim().toLowerCase();
  const matches = term
    ? ports
        .filter((p) =>
          [p.name, p.country ?? "", p.unlocode ?? ""].join(" ").toLowerCase().includes(term),
        )
        .slice(0, 8)
    : [];

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
        <span className="mt-1 flex items-center gap-1 text-[11px] text-positive">
          <Check className="size-3" />
          Linked to a seeded port
        </span>
      ) : null}
      {open && matches.length > 0 ? (
        <div className="panel animate-in absolute left-0 top-[calc(100%+2px)] z-30 w-full max-w-sm overflow-hidden p-1 shadow-[0_8px_24px_-12px_rgba(20,33,61,0.25)]">
          {matches.map((p) => (
            <button
              key={p.id}
              type="button"
              className="focus-ring flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[13px] hover:bg-subtle"
              onClick={() => {
                onChange({ text: p.country ? `${p.name}, ${p.country}` : p.name, portId: p.id });
                setOpen(false);
              }}
            >
              <span className="truncate font-medium">{p.name}</span>
              <span className="ml-auto shrink-0 truncate text-[12px] text-muted-foreground">
                {[p.country, p.unlocode].filter(Boolean).join(" · ")}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </label>
  );
}
