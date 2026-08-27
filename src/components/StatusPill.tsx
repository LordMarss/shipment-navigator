import type { ShipmentStatus } from "@/lib/api";

const TONE: Record<ShipmentStatus, string> = {
  Booked: "bg-subtle text-muted-foreground border-border",
  "In Transit": "bg-warning-soft text-warning border-warning/25",
  "At Port": "bg-warning-soft text-warning border-warning/25",
  "Cleared Customs": "bg-positive-soft text-positive border-positive/25",
  Delivered: "bg-positive-soft text-positive border-positive/25",
};

export function StatusPill({ status }: { status: ShipmentStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap ${TONE[status]}`}
    >
      {status}
    </span>
  );
}
