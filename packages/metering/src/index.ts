export {
  estimateUsage,
  postgresAdmissionMeteringPort,
  reserveUsageForAdmission,
} from "./admission.ts";
export type {
  AdmissionMeteringTransactionPort,
  AdmissionReservationInput,
  AdmissionReservationResult,
  EntitlementSnapshot,
  EstimateUsageInput,
  EstimateUsageResult,
  MeteringPreparationFailure,
  UsageReservationReceipt,
} from "./admission.ts";

export { can, limit } from "./entitlements.ts";
export type {
  EntitlementGrantSnapshot,
  ResolvedCapability,
  ResolvedLimit,
} from "./entitlements.ts";

export {
  commitUsageReservation,
  expireUsageReservation,
  expireUsageReservations,
  releaseUsageReservation,
} from "./reservations.ts";
export type {
  CommitUsageReservationInput,
  ExpireUsageReservationInput,
  ExpireUsageReservationsResult,
  ReleaseUsageReservationInput,
  UsageFinalizationReceipt,
  UsageFinalizationResult,
} from "./reservations.ts";

export { adjustCustomerUsage } from "./adjustments.ts";
export type {
  AdjustCustomerUsageInput,
  AdjustCustomerUsageResult,
  UsageAdjustmentReceipt,
} from "./adjustments.ts";

export { recordProviderCostEvent } from "./provider-costs.ts";
export type {
  ProviderCostReceipt,
  RecordProviderCostInput,
  RecordProviderCostResult,
} from "./provider-costs.ts";

export {
  calculateProviderCost,
  estimateMeteredUsage,
  parseMeterPolicyDocument,
  parsePricingPolicyDocument,
  SETTLEMENT_OUTCOMES,
  settlementActionFor,
} from "./policies.ts";
export type {
  MeterPolicyDocumentV1,
  MeterPolicyTermV1,
  PricedUsage,
  PricedUsageMeasure,
  PricingPolicyDocumentV1,
  PricingRateV1,
  ProviderCostCalculation,
  SettlementAction,
  SettlementOutcome,
  UsageEstimate,
  UsageMeasureRange,
  UsageMeasureRanges,
} from "./policies.ts";

export {
  addDecimalAmounts,
  compareDecimalAmounts,
  DECIMAL_SCALE_DIGITS,
  formatDecimalAmount,
  InvalidDecimalAmountError,
  isZeroDecimalAmount,
  multiplyDecimalAmounts,
  normalizeDecimalAmount,
  parseDecimalAmount,
  subtractDecimalAmounts,
} from "./decimal.ts";

export { withMeteringTransaction } from "./transaction.ts";
export type { MeteringTransaction } from "./transaction.ts";

export { MeteringInputError } from "./validation.ts";
export type {
  CapabilityCheckInput,
  CapabilityDecision,
  EntitlementLimit,
  FiniteEntitlementLimit,
  LimitCheckInput,
  LimitDecision,
  MeteringPeriod,
  MeteringQueryExecutor,
  MeteringQueryResult,
  PeriodWindow,
  PolicyRevisionSnapshot,
  UnlimitedEntitlementLimit,
} from "./types.ts";
