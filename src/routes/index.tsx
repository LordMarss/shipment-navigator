import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { AppShell, btnGhost, btnPrimary, fieldClass } from "@/components/AppShell";
import { StatusPill } from "@/components/StatusPill";
import { createShipment, formatCost, listShipments, shortId } from "@/lib/api";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Shipment Dashboard — StimTech Solutions" },
      {
        name: "description",
        content:
          "Every shipment in one dense table: client, route, pipeline status and landed cost.",
      },
      { property: "og:title", content: "Shipment Dashboard — StimTech Solutions" },
      {
        property: "og:description",
        content: "Track client shipments, routes, status and landed cost in one place.",
      },
    ],
  }),
  component: Dashboard,
});

const EMPTY = {
  client_name: "",
  origin: "",
  destination: "",
  vessel_name: "",
  vessel_mmsi: "",
  landed_cost: "",
};

function Dashboard() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);

  const { data: shipments = [], isLoading } = useQuery({
    queryKey: ["shipments"],
    queryFn: listShipments,
  });

  const create = useMutation({
    mutationFn: () =>
      createShipment({
        client_name: form.client_name.trim(),
        origin: form.origin.trim(),
        destination: form.destination.trim(),
        vessel_name: form.vessel_name.trim() || null,
        vessel_mmsi: form.vessel_mmsi.trim() || null,
        landed_cost: form.landed_cost === "" ? null : Number(form.landed_cost),
      }),
    onSuccess: (shipment) => {
      queryClient.invalidateQueries({ queryKey: ["shipments"] });
      queryClient.invalidateQueries({ queryKey: ["alerts"] });
      setForm(EMPTY);
      setOpen(false);
      toast.success("Shipment created with 4 standard documents");
      navigate({ to: "/shipments/$id", params: { id: shipment.id } });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <AppShell
      title="Shipments"
      description={`${shipments.length} shipment${shipments.length === 1 ? "" : "s"} on record`}
      actions={
        <button className={btnPrimary} onClick={() => setOpen((v) => !v)}>
          {open ? "Cancel" : "New Shipment"}
        </button>
      }
    >
      {open ? (
        <form
          className="panel mb-4 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Client">
              <input
                className={fieldClass}
                required
                value={form.client_name}
                onChange={(e) => setForm({ ...form, client_name: e.target.value })}
                placeholder="Northline Trading"
              />
            </Field>
            <Field label="Origin">
              <input
                className={fieldClass}
                required
                value={form.origin}
                onChange={(e) => setForm({ ...form, origin: e.target.value })}
                placeholder="Shanghai, CN"
              />
            </Field>
            <Field label="Destination">
              <input
                className={fieldClass}
                required
                value={form.destination}
                onChange={(e) => setForm({ ...form, destination: e.target.value })}
                placeholder="Vancouver, CA"
              />
            </Field>
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
                placeholder="Optional · e.g. 477995100"
              />
            </Field>
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
          </div>
          <div className="mt-4 flex items-center gap-2 border-t border-border pt-3">
            <button className={btnPrimary} type="submit" disabled={create.isPending}>
              {create.isPending ? "Creating…" : "Create shipment"}
            </button>
            <button className={btnGhost} type="button" onClick={() => setOpen(false)}>
              Discard
            </button>
          </div>
        </form>
      ) : null}

      <div className="panel overflow-hidden">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-border bg-subtle">
              <Th>ID</Th>
              <Th>Client</Th>
              <Th>Route</Th>
              <Th>Status</Th>
              <Th className="text-right">Landed cost</Th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                  Loading shipments…
                </td>
              </tr>
            ) : shipments.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-10 text-center text-muted-foreground">
                  No shipments yet. Create your first one to get started.
                </td>
              </tr>
            ) : (
              shipments.map((s) => (
                <tr
                  key={s.id}
                  onClick={() => navigate({ to: "/shipments/$id", params: { id: s.id } })}
                  className="cursor-pointer border-b border-border last:border-0 transition-colors hover:bg-subtle"
                >
                  <td className="px-3 py-2 font-medium text-muted-foreground">{shortId(s.id)}</td>
                  <td className="px-3 py-2 font-medium">{s.client_name}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {s.origin} → {s.destination}
                  </td>
                  <td className="px-3 py-2">
                    <StatusPill status={s.status} />
                  </td>
                  <td className="px-3 py-2 text-right">{formatCost(s.landed_cost)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </AppShell>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={`px-3 py-2 text-left text-[11px] font-medium uppercase tracking-[0.04em] text-muted-foreground ${className}`}
    >
      {children}
    </th>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="label-xs mb-1 block">{label}</span>
      {children}
    </label>
  );
}
