import { HeaderTabs } from "@/components/AppShell";
import { useFleet } from "@/components/maritime/useFleet";

/** All / Active / Completed, each its own route, with the count it holds. */
export function ShipmentBookTabs() {
  const { all, isLoading } = useFleet();
  const delivered = all.filter((s) => s.status === "Delivered").length;
  const n = (v: number) => (isLoading ? undefined : v);
  return (
    <HeaderTabs
      items={[
        { to: "/shipments", label: "All", count: n(all.length) },
        { to: "/shipments/active", label: "Active", count: n(all.length - delivered) },
        { to: "/shipments/completed", label: "Completed", count: n(delivered) },
      ]}
    />
  );
}
