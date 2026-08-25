export const DECIMAL_SCALE_DIGITS = 9;
const SCALE = 1_000_000_000n;
const MAX_SCALED_AMOUNT = (10n ** 38n) - 1n;
const DECIMAL_PATTERN = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]{1,9}))?$/;

export class InvalidDecimalAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDecimalAmountError";
  }
}

export function parseDecimalAmount(
  value: string,
  options: { readonly allowNegative?: boolean } = {},
): bigint {
  if (typeof value !== "string") {
    throw new InvalidDecimalAmountError("amount must be a decimal string");
  }
  const match = DECIMAL_PATTERN.exec(value);
  if (match === null) {
    throw new InvalidDecimalAmountError(
      "amount must use plain decimal notation with at most 9 fractional digits",
    );
  }

  const negative = match[1] === "-";
  if (negative && !options.allowNegative) {
    throw new InvalidDecimalAmountError("amount must not be negative");
  }

  const integer = BigInt(match[2]);
  const fractional = BigInt((match[3] ?? "").padEnd(DECIMAL_SCALE_DIGITS, "0"));
  const scaled = integer * SCALE + fractional;
  if (scaled > MAX_SCALED_AMOUNT) {
    throw new InvalidDecimalAmountError("amount exceeds numeric(38, 9)");
  }
  return negative && scaled !== 0n ? -scaled : scaled;
}

export function formatDecimalAmount(value: bigint): string {
  if (value > MAX_SCALED_AMOUNT || value < -MAX_SCALED_AMOUNT) {
    throw new InvalidDecimalAmountError("amount exceeds numeric(38, 9)");
  }
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const integer = absolute / SCALE;
  const fractional = (absolute % SCALE).toString().padStart(
    DECIMAL_SCALE_DIGITS,
    "0",
  ).replace(/0+$/, "");
  const formatted = fractional.length === 0
    ? integer.toString()
    : `${integer}.${fractional}`;
  return negative && absolute !== 0n ? `-${formatted}` : formatted;
}

export function normalizeDecimalAmount(
  value: string,
  options: { readonly allowNegative?: boolean } = {},
): string {
  return formatDecimalAmount(parseDecimalAmount(value, options));
}

export function addDecimalAmounts(values: readonly string[]): string {
  let total = 0n;
  for (const value of values) total += parseDecimalAmount(value);
  return formatDecimalAmount(total);
}

export function compareDecimalAmounts(left: string, right: string): number {
  const leftScaled = parseDecimalAmount(left, { allowNegative: true });
  const rightScaled = parseDecimalAmount(right, { allowNegative: true });
  return leftScaled < rightScaled ? -1 : leftScaled > rightScaled ? 1 : 0;
}

export function multiplyDecimalAmounts(
  left: string,
  right: string,
  rounding: "floor" | "half_up" | "ceil",
): string {
  const leftScaled = parseDecimalAmount(left);
  const rightScaled = parseDecimalAmount(right);
  const product = leftScaled * rightScaled;
  const quotient = product / SCALE;
  const remainder = product % SCALE;
  let rounded = quotient;
  if (rounding === "ceil" && remainder > 0n) rounded += 1n;
  if (rounding === "half_up" && remainder * 2n >= SCALE) rounded += 1n;
  return formatDecimalAmount(rounded);
}

export function subtractDecimalAmounts(
  left: string,
  right: string,
  options: { readonly allowNegative?: boolean } = {},
): string {
  const result = parseDecimalAmount(left, { allowNegative: true }) -
    parseDecimalAmount(right, { allowNegative: true });
  if (result < 0n && !options.allowNegative) {
    throw new InvalidDecimalAmountError("amount must not be negative");
  }
  return formatDecimalAmount(result);
}

export function isZeroDecimalAmount(value: string): boolean {
  return parseDecimalAmount(value, { allowNegative: true }) === 0n;
}
