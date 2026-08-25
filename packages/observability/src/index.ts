export { createServiceInstanceId, loadObservabilityConfig } from "./config.ts";
export type {
  ObservabilityConfig,
  ObservabilityResourceAttributes,
  RelayServiceName,
  RelayTraceSampler,
} from "./config.ts";

export {
  INVALID_VALUE,
  REDACTED_VALUE,
  sanitizeIdentifier,
  sanitizeRouteTemplate,
  sanitizeTelemetryText,
  sanitizeVersion,
  TELEMETRY_VALUE_LIMITS,
  TRUNCATED_VALUE,
  UNKNOWN_ROUTE,
} from "./redaction.ts";

export {
  isNormalizedErrorType,
  NORMALIZED_ERROR_TYPES,
  normalizeError,
} from "./errors.ts";
export type {
  NormalizedError,
  NormalizedErrorType,
  NormalizeErrorOptions,
} from "./errors.ts";

export {
  AttributeGuard,
  CONTROLLED_TELEMETRY_ATTRIBUTE_KEYS,
  TELEMETRY_ATTRIBUTE_KEYS,
} from "./attributes.ts";
export type {
  AttributeGuardOptions,
  ControlledTelemetryAttributeKey,
  TelemetryAttributeKey,
  TelemetryAttributes,
  TelemetryAttributeValue,
} from "./attributes.ts";

export { extractTraceContext, injectTraceContext } from "./context.ts";
export type { TraceContextCarrier, TracePropagationApi } from "./context.ts";

export {
  createRelayTelemetry,
  RELAY_METRIC_NAMES,
  RelayTelemetry,
} from "./telemetry.ts";
export type {
  ActiveSpanEnrichment,
  GaugeObserver,
  ObservableGaugeRegistration,
  RelayCounterMetricName,
  RelayHistogramMetricName,
  RelayMetricInstrumentKind,
  RelayMetricName,
  RelayObservableGaugeMetricName,
  RelaySpanKind,
  RelaySpanOptions,
  RelayTelemetryOptions,
  RelayUpDownCounterMetricName,
  SafeCounter,
  SafeHistogram,
  SafeSpan,
  SafeUpDownCounter,
  TelemetryDependencies,
} from "./telemetry.ts";

export { createJsonLogger, JsonLogger, LOG_SEVERITIES } from "./logger.ts";
export type {
  LogEvent,
  LoggerOptions,
  LogRecord,
  LogSeverity,
  LogSink,
} from "./logger.ts";

export { createHonoRouteEnrichment } from "./hono.ts";
export type {
  HonoCompatibleContext,
  HonoCompatibleMiddleware,
  HonoCompatibleNext,
  HonoCompatibleRequest,
  HonoRouteEnrichmentOptions,
} from "./hono.ts";
