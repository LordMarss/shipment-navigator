/**
 * Compatibility layer. All lifecycle intelligence now lives in lib/lifecycle.ts;
 * this module simply re-exports it so older imports keep working.
 */
export {
  docsFor,
  shipmentHealth,
  kpis,
  alertSeverity,
  relativeTime,
  SEVERITY_LABEL,
  DEFAULT_MONITORING_CONFIG,
} from "@/lib/lifecycle";

export type { Health, HealthLevel, Severity, MonitoringConfig } from "@/lib/lifecycle";
