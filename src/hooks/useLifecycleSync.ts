import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { applyAutomation, type Shipment } from "@/lib/api";
import { deriveAutomation } from "@/lib/autoStatus";
import type { MonitoringConfig } from "@/lib/lifecycle";

/**
 * Runs the automated status pipeline over the loaded shipments.
 *
 * Deliberately simple: it only writes when the derived status or monitoring
 * state differs from what is stored, skips shipments outside their monitoring
 * window (they derive to the same values, so nothing is written), and never
 * touches completed shipments. Manual status changes remain intact because
 * automation only ever moves a shipment forward.
 */
export function useLifecycleSync(shipments: Shipment[], config: MonitoringConfig) {
  const queryClient = useQueryClient();
  const handled = useRef(new Set<string>());

  useEffect(() => {
    if (shipments.length === 0) return;
    let cancelled = false;

    (async () => {
      let wrote = false;
      for (const shipment of shipments) {
        const decision = deriveAutomation(shipment, config);
        if (!decision.statusChanged && !decision.monitoringChanged) continue;

        // One write per shipment state per session; avoids repeat writes on refetch.
        const fingerprint = `${shipment.id}:${decision.status}:${decision.monitoring_state}`;
        if (handled.current.has(fingerprint)) continue;
        handled.current.add(fingerprint);

        try {
          await applyAutomation(shipment, decision);
          wrote = true;
        } catch {
          handled.current.delete(fingerprint);
        }
      }

      if (wrote && !cancelled) {
        queryClient.invalidateQueries({ queryKey: ["shipments"] });
        queryClient.invalidateQueries({ queryKey: ["shipment"] });
        queryClient.invalidateQueries({ queryKey: ["events"] });
        queryClient.invalidateQueries({ queryKey: ["alerts"] });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [shipments, config, queryClient]);
}
