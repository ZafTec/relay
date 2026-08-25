export class MeteringInputError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(`${field}: ${message}`);
    this.name = "MeteringInputError";
  }
}

export function requireText(
  value: string,
  field: string,
  maxLength: number = 256,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MeteringInputError(field, "must be a non-empty string");
  }
  if (value.length > maxLength) {
    throw new MeteringInputError(
      field,
      `must be at most ${maxLength} characters`,
    );
  }
  return value;
}

export function requireKey(value: string, field: string): string {
  requireText(value, field, 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new MeteringInputError(field, "contains unsupported characters");
  }
  return value;
}

export function requirePositiveSafeInteger(
  value: number,
  field: string,
  maximum: number = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new MeteringInputError(
      field,
      `must be a positive safe integer no greater than ${maximum}`,
    );
  }
  return value;
}
