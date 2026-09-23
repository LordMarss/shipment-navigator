import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { toast } from "sonner";

import { btnGhost, btnPrimary, fieldClass } from "@/components/AppShell";
import { PortAutocomplete } from "@/components/PortAutocomplete";
import { createShipment } from "@/lib/api";

const EMPTY = {
  client_name: "",
  origin: "",
  origin_port_id: null as string | null,
  destination: "",
  destination_port_id: null as string | null,
  vessel_name: "",
  vessel_mmsi: "",
  landed_cost: "",
  planned_etd: "",
  planned_eta: "",
};

/** datetime-local value ("2026-09-11T14:30") → ISO timestamp. */
function toIso(value: string) {
  return value ? new Date(value).toISOString() : null;
}

export function NewShipmentForm({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form, setForm] = useState(EMPTY);

  const mmsi = form.vessel_mmsi.trim();
  const mmsiValid = /^\d{9}$/.test(mmsi);

  const create = useMutation({
    mutationFn: () =>
      createShipment({
        client_name: form.client_name.trim(),
        origin: form.origin.trim(),
        origin_port_id: form.origin_port_id,
        destination: form.destination.trim(),
        destination_port_id: form.destination_port_id,
        vessel_name: form.vessel_name.trim() || null,
        vessel_mmsi: mmsi || null,
        landed_cost: form.landed_cost === "" ? null : Number(form.landed_cost),
        planned_etd: toIso(form.planned_etd),
        planned_eta: toIso(form.planned_eta),
        eta: toIso(form.planned_eta),
      }),
    onSuccess: (shipment) => {
      queryClient.invalidateQueries({ queryKey: ["shipments"] });
      queryClient.invalidateQueries({ queryKey: ["alerts"] });
      queryClient.invalidateQueries({ queryKey: ["all-documents"] });
      toast.success("Shipment created with 4 standard documents");
      navigate({ to: "/shipments/$id", params: { id: shipment.id } });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <form
      className="panel animate-in mb-6 overflow-hidden"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-base font-semibold">New shipment</h2>
        <p className="text-xs text-muted-foreground">
          Four standard trade documents are created automatically.
        </p>
      </div>

      <Section title="Shipment" hint="Who the shipment is for and where it moves.">
        <Field label="Client">
          <input
            className={fieldClass}
            required
            value={form.client_name}
            onChange={(e) => setForm({ ...form, client_name: e.target.value })}
            placeholder="Northline Trading"
          />
        </Field>
        <PortAutocomplete
          label="Origin"
          required
          value={form.origin}
          portId={form.origin_port_id}
          placeholder="Shanghai, CN"
          onChange={({ text, portId }) =>
            setForm({ ...form, origin: text, origin_port_id: portId })
          }
        />
        <PortAutocomplete
          label="Destination"
          required
          value={form.destination}
          portId={form.destination_port_id}
          placeholder="Vancouver, CA"
          onChange={({ text, portId }) =>
            setForm({ ...form, destination: text, destination_port_id: portId })
          }
        />
      </Section>

      <Section title="Vessel" hint="An MMSI enables live tracking on the fleet map.">
        <Field label="Vessel name">
          <input
            className={fieldClass}
            value={form.vessel_name}
            onChange={(e) => setForm({ ...form, vessel_name: e.target.value })}
            placeholder="Optional"
          />
        </Field>
        <Field label="Vessel MMSI">
          <input
            className={fieldClass}
            value={form.vessel_mmsi}
            onChange={(e) => setForm({ ...form, vessel_mmsi: e.target.value })}
            placeholder="9 digits · e.g. 477995100"
            inputMode="numeric"
          />
        </Field>
        <Field label="Planned departure (ETD)">
          <input
            className={fieldClass}
            type="datetime-local"
            value={form.planned_etd}
            onChange={(e) => setForm({ ...form, planned_etd: e.target.value })}
          />
        </Field>
        <Field label="Planned arrival (ETA)">
          <input
            className={fieldClass}
            type="datetime-local"
            value={form.planned_eta}
            onChange={(e) => setForm({ ...form, planned_eta: e.target.value })}
          />
        </Field>
        {mmsi ? (
          <div className="sm:col-span-3">
            {mmsiValid ? (
              <p className="flex items-center gap-1.5 text-xs text-positive">
                <Check className="size-3.5" />
                Vessel found on the fleet map
                {form.vessel_name.trim() ? (
                  <span className="text-muted-foreground">
                    · {form.vessel_name.trim()} · MMSI {mmsi}
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    · MMSI {mmsi} · no vessel name provided
                  </span>
                )}
              </p>
            ) : (
              <p className="text-xs text-warning">
                An MMSI is 9 digits. Live tracking stays off until a valid MMSI is saved.
              </p>
            )}
          </div>
        ) : null}
      </Section>

      <Section title="Commercial" hint="Used for the landed cost totals on the dashboard.">
        <Field label="Landed cost (USD)">
          <input
            className={fieldClass}
            type="number"
            step="0.01"
            value={form.landed_cost}
            onChange={(e) => setForm({ ...form, landed_cost: e.target.value })}
            placeholder="Optional"
          />
        </Field>
      </Section>

      <div className="flex items-center gap-2 border-t border-border bg-subtle/50 px-5 py-3.5">
        <button className={btnPrimary} type="submit" disabled={create.isPending}>
          {create.isPending ? "Creating…" : "Create shipment"}
        </button>
        <button className={btnGhost} type="button" onClick={onClose}>
          Discard
        </button>
      </div>
    </form>
  );
}

function Section({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-4 border-b border-border px-5 py-5 lg:grid-cols-[180px_1fr]">
      <div>
        <p className="flex items-baseline gap-2">
          <span className="text-sm font-semibold">{title}</span>
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="label-xs mb-1 block">{label}</span>
      {children}
    </label>
  );
}
