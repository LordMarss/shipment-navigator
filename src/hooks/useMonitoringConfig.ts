import { useQuery } from "@tanstack/react-query";

import { listSettings } from "@/lib/api";
import { DEFAULT_MONITORING_CONFIG, type MonitoringConfig } from "@/lib/lifecycle";

/**
 * Workspace monitoring configuration. The stored `app_settings` values always
 * win; the defaults only cover the first render before they load.
 */
export function useMonitoringConfig(): MonitoringConfig {
  const { data } = useQuery({ queryKey: ["app-settings"], queryFn: listSettings });
  return {
    monitoring_start_offset_days:
      data?.["monitoring_start_offset_days"] ??
      DEFAULT_MONITORING_CONFIG.monitoring_start_offset_days,
    pre_monitoring_window_days:
      data?.["pre_monitoring_window_days"] ?? DEFAULT_MONITORING_CONFIG.pre_monitoring_window_days,
    eta_attention_hours:
      data?.["eta_attention_hours"] ?? DEFAULT_MONITORING_CONFIG.eta_attention_hours,
    eta_risk_hours: data?.["eta_risk_hours"] ?? DEFAULT_MONITORING_CONFIG.eta_risk_hours,
  };
}
