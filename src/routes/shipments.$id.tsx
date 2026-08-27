import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { AppShell, btnDanger, btnGhost, btnPrimary, fieldClass } from "@/components/AppShell";
import { StatusPill } from "@/components/StatusPill";
import {
  advanceStatus,
  deleteShipment,
  formatCost,
  getShipment,
  listDocuments,
  nextStatus,
  shortId,
  STATUSES,
  toggleDocument,
  updateShipment,
  type Shipment,
  type ShipmentDocument,
} from "@/lib/api";

export const Route = createFileRoute("/shipments/$id")({
  head: () => ({
    meta: [
      { title: "Shipment Detail — StimTech Solutions" },
      {
        name: "description",
        content:
          "Edit shipment details, advance the customs pipeline and tick off required trade documents.",
      },
      { property: "og:title", content: "Shipment Detail — StimTech Solutions" },
      {
        property: "og:description",
        content: "Pipeline status, document checklist and landed cost for a single shipment.",
      },
    ],
  }),
  component: ShipmentDetail,
});

function ShipmentDetail() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: shipment, isLoading } = useQuery({
    queryKey: ["shipment", id],
    queryFn: () => getShipment(id),
  });
  const { data: documents = [] } = useQuery({
    queryKey: ["documents", id],
    queryFn: () => listDocuments(id),
  });

  const [draft, setDraft] = useState<Shipment | null>(null);
  useEffect(() => {
    if (shipment) setDraft(shipment);
  }, [shipment]);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["shipment", id] });
    queryClient.invalidateQueries({ queryKey: ["shipments"] });
    queryClient.invalidateQueries({ queryKey: ["alerts"] });
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!draft) return;
      await updateShipment(id, {
        client_name: draft.client_name,
        origin: draft.origin,
        destination: draft.destination,
        vessel_name: draft.vessel_name || null,
        vessel_mmsi: draft.vessel_mmsi || null,
        landed_cost: draft.landed_cost == null ? null : Number(draft.landed_cost),
      });
    },
    onSuccess: () => {
      refresh();
      toast.success("Shipment updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const advance = useMutation({
    mutationFn: async () => {
      if (shipment) await advanceStatus(shipment);
    },
    onSuccess: () => {
      refresh();
      toast.success("Status advanced");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleDoc = useMutation({
    mutationFn: (doc: ShipmentDocument) => toggleDocument(doc),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["documents", id] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: () => deleteShipment(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["shipments"] });
      queryClient.invalidateQueries({ queryKey: ["alerts"] });
      toast.success("Shipment deleted");
      navigate({ to: "/" });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) {
    return (
      <AppShell title="Shipment">
        <p className="panel px-3 py-8 text-center text-[13px] text-muted-foreground">Loading…</p>
      </AppShell>
    );
  }

  if (!shipment || !draft) {
    return (
      <AppShell title="Shipment not found">
        <div className="panel px-3 py-8 text-center text-[13px] text-muted-foreground">
          This shipment no longer exists.{" "}
          <Link to="/" className="text-primary hover:underline">
            Back to dashboard
          </Link>
        </div>
      </AppShell>
    );
  }

  const currentIndex = STATUSES.indexOf(shipment.status);
  const next = nextStatus(shipment.status);
  const doneCount = documents.filter((d) => d.done).length;

  return (
    <AppShell
      title={`${shortId(shipment.id)} · ${shipment.client_name}`}
      description={`${shipment.origin} → ${shipment.destination} · ${formatCost(shipment.landed_cost)} landed cost`}
      actions={
        <>
          <Link to="/" className={btnGhost}>
            Back
          </Link>
          <button
            className={btnPrimary}
            disabled={!next || advance.isPending}
            onClick={() => advance.mutate()}
          >
            {next ? `Advance to ${next}` : "Delivered"}
          </button>
        </>
      }
    >
      <div className="panel mb-4 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[13px] font-semibold">Status pipeline</h2>
          <StatusPill status={shipment.status} />
        </div>
        <ol className="flex flex-wrap items-stretch gap-1.5">
          {STATUSES.map((s, i) => {
            const active = i === currentIndex;
            const past = i < currentIndex;
            return (
              <li
                key={s}
                className={`flex-1 min-w-[120px] rounded-sm border px-2.5 py-2 text-[12px] ${
                  active
                    ? "border-primary bg-primary text-primary-foreground font-semibold"
                    : past
                      ? "border-border bg-subtle text-foreground font-medium"
                      : "border-border bg-surface text-muted-foreground"
                }`}
              >
                <span className="block text-[10px] opacity-70">Stage {i + 1}</span>
                {s}
              </li>
            );
          })}
        </ol>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
        <form
          className="panel p-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <h2 className="mb-3 text-[13px] font-semibold">Shipment info</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Client">
              <input
                className={fieldClass}
                value={draft.client_name}
                onChange={(e) => setDraft({ ...draft, client_name: e.target.value })}
              />
            </Field>
            <Field label="Landed cost (USD)">
              <input
                className={fieldClass}
                type="number"
                step="0.01"
                value={draft.landed_cost ?? ""}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    landed_cost: e.target.value === "" ? null : Number(e.target.value),
                  })
                }
              />
            </Field>
            <Field label="Origin">
              <input
                className={fieldClass}
                value={draft.origin}
                onChange={(e) => setDraft({ ...draft, origin: e.target.value })}
              />
            </Field>
            <Field label="Destination">
              <input
                className={fieldClass}
                value={draft.destination}
                onChange={(e) => setDraft({ ...draft, destination: e.target.value })}
              />
            </Field>
            <Field label="Vessel name">
              <input
                className={fieldClass}
                value={draft.vessel_name ?? ""}
                onChange={(e) => setDraft({ ...draft, vessel_name: e.target.value })}
              />
            </Field>
            <Field label="Vessel MMSI">
              <input
                className={fieldClass}
                value={draft.vessel_mmsi ?? ""}
                onChange={(e) => setDraft({ ...draft, vessel_mmsi: e.target.value })}
              />
            </Field>
          </div>
          <div className="mt-4 flex items-center justify-between gap-2 border-t border-border pt-3">
            <div className="flex items-center gap-2">
              <button className={btnPrimary} type="submit" disabled={save.isPending}>
                {save.isPending ? "Saving…" : "Save changes"}
              </button>
              <Link to="/map" className={btnGhost}>
                Fleet map
              </Link>
            </div>
            <button
              type="button"
              className={btnDanger}
              onClick={() => {
                if (confirm("Delete this shipment and its documents?")) remove.mutate();
              }}
            >
              Delete
            </button>
          </div>
        </form>

        <div className="panel p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[13px] font-semibold">Documents</h2>
            <span className="text-[12px] text-muted-foreground">
              {doneCount}/{documents.length} complete
            </span>
          </div>
          <ul className="divide-y divide-border">
            {documents.map((doc) => (
              <li key={doc.id}>
                <label className="flex cursor-pointer items-center gap-2.5 py-2 text-[13px]">
                  <input
                    type="checkbox"
                    checked={doc.done}
                    onChange={() => toggleDoc.mutate(doc)}
                    className="size-3.5 accent-[var(--primary)]"
                  />
                  <span className={doc.done ? "text-muted-foreground line-through" : ""}>
                    {doc.name}
                  </span>
                </label>
              </li>
            ))}
            {documents.length === 0 ? (
              <li className="py-3 text-[13px] text-muted-foreground">No documents.</li>
            ) : null}
          </ul>
        </div>
      </div>
    </AppShell>
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
