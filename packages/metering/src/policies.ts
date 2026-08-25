import {
  addDecimalAmounts,
  compareDecimalAmounts,
  multiplyDecimalAmounts,
  normalizeDecimalAmount,
} from "./decimal.ts";
import type { MeteringPeriod } from "./types.ts";

export const SETTLEMENT_OUTCOMES = [
  "success",
  "partial_output",
  "validation_rejected",
  "safety_rejected",
  "provider_failure",
  "cancelled",
  "timed_out",
  "storage_failure",
] as const;

export type SettlementOutcome = typeof SETTLEMENT_OUTCOMES[number];
export type SettlementAction = "commit_actual" | "release";

export interface UsageMeasureRange {
  readonly minimum: string;
  readonly expected: string;
  readonly maximum: string;
}

export type UsageMeasureRanges = Readonly<Record<string, UsageMeasureRange>>;

export interface MeterPolicyTermV1 {
  readonly measure: string;
  readonly rate: string;
}

export interface MeterPolicyDocumentV1 {
  readonly schemaVersion: 1;
  readonly metric: string;
  readonly unit: string;
  readonly period: MeteringPeriod;
  readonly estimate: {
    readonly base: string;
    readonly terms: readonly MeterPolicyTermV1[];
  };
  readonly reservation: {
    readonly multiplier: string;
    readonly minimum: string;
  };
  readonly settlement: Readonly<Record<SettlementOutcome, SettlementAction>>;
}

export interface UsageEstimate {
  readonly metric: string;
  readonly unit: string;
  readonly period: MeteringPeriod;
  readonly minimum: string;
  readonly expected: string;
  readonly maximum: string;
  readonly reserve: string;
  readonly measures: UsageMeasureRanges;
}

export interface PricingRateV1 {
  readonly measure: string;
  readonly unit: string;
  readonly pricePerUnit: string;
}

export interface PricingPolicyDocumentV1 {
  readonly schemaVersion: 1;
  readonly currency: string;
  readonly rates: readonly PricingRateV1[];
  readonly minimumCost: string;
}

export interface PricedUsageMeasure {
  readonly quantity: string;
  readonly unit: string;
}

export type PricedUsage = Readonly<Record<string, PricedUsageMeasure>>;

export interface ProviderCostCalculation {
  readonly currency: string;
  readonly amount: string;
  readonly components: readonly {
    readonly measure: string;
    readonly unit: string;
    readonly quantity: string;
    readonly pricePerUnit: string;
    readonly amount: string;
  }[];
}

export class InvalidPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPolicyError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidPolicyError(`${field} must be a non-empty string`);
  }
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  field: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new InvalidPolicyError(`${field} contains unsupported fields`);
  }
}

function decimal(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidPolicyError(`${field} must be a decimal string`);
  }
  try {
    return normalizeDecimalAmount(value);
  } catch (error) {
    throw new InvalidPolicyError(
      `${field} is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function parsePeriod(value: unknown): MeteringPeriod {
  if (
    value !== "calendar_day" && value !== "calendar_month" &&
    value !== "lifetime"
  ) {
    throw new InvalidPolicyError("period is unsupported");
  }
  return value;
}

export function parseMeterPolicyDocument(
  value: unknown,
): MeterPolicyDocumentV1 {
  if (!isRecord(value)) {
    throw new InvalidPolicyError("meter policy must be an object");
  }
  exactKeys(
    value,
    [
      "schemaVersion",
      "metric",
      "unit",
      "period",
      "estimate",
      "reservation",
      "settlement",
    ],
    "meter policy",
  );
  if (value.schemaVersion !== 1) {
    throw new InvalidPolicyError("unsupported meter policy schemaVersion");
  }
  const metric = nonEmptyString(value.metric, "metric");
  const unit = nonEmptyString(value.unit, "unit");
  const period = parsePeriod(value.period);

  if (!isRecord(value.estimate)) {
    throw new InvalidPolicyError("estimate must be an object");
  }
  exactKeys(value.estimate, ["base", "terms"], "estimate");
  const base = decimal(value.estimate.base, "estimate.base");
  if (!Array.isArray(value.estimate.terms)) {
    throw new InvalidPolicyError("estimate.terms must be an array");
  }
  const seenMeasures = new Set<string>();
  const terms = value.estimate.terms.map((term, index): MeterPolicyTermV1 => {
    if (!isRecord(term)) {
      throw new InvalidPolicyError(
        `estimate.terms[${index}] must be an object`,
      );
    }
    exactKeys(term, ["measure", "rate"], `estimate.terms[${index}]`);
    const measure = nonEmptyString(
      term.measure,
      `estimate.terms[${index}].measure`,
    );
    if (seenMeasures.has(measure)) {
      throw new InvalidPolicyError(`duplicate estimate measure: ${measure}`);
    }
    seenMeasures.add(measure);
    return {
      measure,
      rate: decimal(term.rate, `estimate.terms[${index}].rate`),
    };
  });

  if (!isRecord(value.reservation)) {
    throw new InvalidPolicyError("reservation must be an object");
  }
  exactKeys(value.reservation, ["multiplier", "minimum"], "reservation");
  const multiplier = decimal(
    value.reservation.multiplier,
    "reservation.multiplier",
  );
  if (compareDecimalAmounts(multiplier, "1") < 0) {
    throw new InvalidPolicyError("reservation.multiplier must be at least 1");
  }
  const minimum = decimal(value.reservation.minimum, "reservation.minimum");

  if (!isRecord(value.settlement)) {
    throw new InvalidPolicyError("settlement must be an object");
  }
  exactKeys(value.settlement, SETTLEMENT_OUTCOMES, "settlement");
  const settlement = {} as Record<SettlementOutcome, SettlementAction>;
  for (const outcome of SETTLEMENT_OUTCOMES) {
    const action = value.settlement[outcome];
    if (action !== "commit_actual" && action !== "release") {
      throw new InvalidPolicyError(`settlement.${outcome} is unsupported`);
    }
    settlement[outcome] = action;
  }

  return {
    schemaVersion: 1,
    metric,
    unit,
    period,
    estimate: { base, terms },
    reservation: { multiplier, minimum },
    settlement,
  };
}

function parseMeasureRange(name: string, value: unknown): UsageMeasureRange {
  if (!isRecord(value)) {
    throw new InvalidPolicyError(`measure ${name} must be an object`);
  }
  exactKeys(value, ["minimum", "expected", "maximum"], `measure ${name}`);
  const minimum = decimal(value.minimum, `measure ${name}.minimum`);
  const expected = decimal(value.expected, `measure ${name}.expected`);
  const maximum = decimal(value.maximum, `measure ${name}.maximum`);
  if (
    compareDecimalAmounts(minimum, expected) > 0 ||
    compareDecimalAmounts(expected, maximum) > 0
  ) {
    throw new InvalidPolicyError(
      `measure ${name} must satisfy minimum <= expected <= maximum`,
    );
  }
  return { minimum, expected, maximum };
}

export function estimateMeteredUsage(
  rawPolicy: unknown,
  rawMeasures: Readonly<Record<string, unknown>>,
): UsageEstimate {
  const policy = parseMeterPolicyDocument(rawPolicy);
  const measures: Record<string, UsageMeasureRange> = {};
  const lowerParts = [policy.estimate.base];
  const expectedParts = [policy.estimate.base];
  const upperParts = [policy.estimate.base];

  for (const term of policy.estimate.terms) {
    if (!(term.measure in rawMeasures)) {
      throw new InvalidPolicyError(
        `required measure is missing: ${term.measure}`,
      );
    }
    const range = parseMeasureRange(term.measure, rawMeasures[term.measure]);
    measures[term.measure] = range;
    lowerParts.push(multiplyDecimalAmounts(range.minimum, term.rate, "floor"));
    expectedParts.push(
      multiplyDecimalAmounts(range.expected, term.rate, "half_up"),
    );
    upperParts.push(multiplyDecimalAmounts(range.maximum, term.rate, "ceil"));
  }

  const minimum = addDecimalAmounts(lowerParts);
  const expected = addDecimalAmounts(expectedParts);
  const maximum = addDecimalAmounts(upperParts);
  const multipliedReserve = multiplyDecimalAmounts(
    maximum,
    policy.reservation.multiplier,
    "ceil",
  );
  const reserve = compareDecimalAmounts(
      multipliedReserve,
      policy.reservation.minimum,
    ) >= 0
    ? multipliedReserve
    : policy.reservation.minimum;

  return {
    metric: policy.metric,
    unit: policy.unit,
    period: policy.period,
    minimum,
    expected,
    maximum,
    reserve,
    measures,
  };
}

export function settlementActionFor(
  rawPolicy: unknown,
  outcome: SettlementOutcome,
): SettlementAction {
  return parseMeterPolicyDocument(rawPolicy).settlement[outcome];
}

export function parsePricingPolicyDocument(
  value: unknown,
): PricingPolicyDocumentV1 {
  if (!isRecord(value)) {
    throw new InvalidPolicyError("pricing policy must be an object");
  }
  exactKeys(
    value,
    ["schemaVersion", "currency", "rates", "minimumCost"],
    "pricing policy",
  );
  if (value.schemaVersion !== 1) {
    throw new InvalidPolicyError("unsupported pricing policy schemaVersion");
  }
  const currency = nonEmptyString(value.currency, "currency");
  if (!/^[A-Z][A-Z0-9_]{2,11}$/.test(currency)) {
    throw new InvalidPolicyError(
      "currency must be an uppercase accounting unit",
    );
  }
  if (!Array.isArray(value.rates) || value.rates.length === 0) {
    throw new InvalidPolicyError("rates must be a non-empty array");
  }
  const seenMeasures = new Set<string>();
  const rates = value.rates.map((rate, index): PricingRateV1 => {
    if (!isRecord(rate)) {
      throw new InvalidPolicyError(`rates[${index}] must be an object`);
    }
    exactKeys(
      rate,
      ["measure", "unit", "pricePerUnit"],
      `rates[${index}]`,
    );
    const measure = nonEmptyString(rate.measure, `rates[${index}].measure`);
    if (seenMeasures.has(measure)) {
      throw new InvalidPolicyError(`duplicate pricing measure: ${measure}`);
    }
    seenMeasures.add(measure);
    return {
      measure,
      unit: nonEmptyString(rate.unit, `rates[${index}].unit`),
      pricePerUnit: decimal(
        rate.pricePerUnit,
        `rates[${index}].pricePerUnit`,
      ),
    };
  });
  return {
    schemaVersion: 1,
    currency,
    rates,
    minimumCost: decimal(value.minimumCost, "minimumCost"),
  };
}

export function calculateProviderCost(
  rawPolicy: unknown,
  rawUsage: Readonly<Record<string, unknown>>,
): ProviderCostCalculation {
  const policy = parsePricingPolicyDocument(rawPolicy);
  const components = policy.rates.map((rate) => {
    const rawMeasure = rawUsage[rate.measure];
    if (!isRecord(rawMeasure)) {
      throw new InvalidPolicyError(
        `required pricing measure is missing: ${rate.measure}`,
      );
    }
    exactKeys(rawMeasure, ["quantity", "unit"], `usage.${rate.measure}`);
    if (rawMeasure.unit !== rate.unit) {
      throw new InvalidPolicyError(
        `usage.${rate.measure}.unit does not match pricing policy`,
      );
    }
    const quantity = decimal(
      rawMeasure.quantity,
      `usage.${rate.measure}.quantity`,
    );
    return {
      measure: rate.measure,
      unit: rate.unit,
      quantity,
      pricePerUnit: rate.pricePerUnit,
      amount: multiplyDecimalAmounts(quantity, rate.pricePerUnit, "ceil"),
    };
  });
  const calculated = addDecimalAmounts(
    components.map((component) => component.amount),
  );
  return {
    currency: policy.currency,
    amount: compareDecimalAmounts(calculated, policy.minimumCost) >= 0
      ? calculated
      : policy.minimumCost,
    components,
  };
}
