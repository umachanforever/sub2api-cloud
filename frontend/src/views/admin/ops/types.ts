// Shared types for the Ops frontend view layer (decoupled from backend DTOs).

export type ChartState = 'loading' | 'empty' | 'ready'

// Re-export ops alert/settings types so view components can import from a single place
// while keeping the API contract centralized in `@/api/admin/ops`.
export type {
  AlertRule,
  AlertEvent,
  AlertSeverity,
  ThresholdMode,
  MetricType,
  Operator,
  EmailNotificationConfig,
  OpsDistributedLockSettings,
  OpsAlertRuntimeSettings,
  OpsMetricThresholds,
  OpsAdvancedSettings,
  OpsDataRetentionSettings,
  OpsAggregationSettings,
  OpsRuntimeLogConfig,
  OpsSystemLog,
  OpsSystemLogSinkHealth
} from '@/api/admin/ops'
