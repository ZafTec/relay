import type { MeteringPeriod, PeriodWindow } from "./types.ts";

export function periodWindow(at: Date, kind: MeteringPeriod): PeriodWindow {
  if (Number.isNaN(at.getTime())) {
    throw new TypeError("at must be a valid date");
  }

  if (kind === "calendar_day") {
    const startsAt = new Date(Date.UTC(
      at.getUTCFullYear(),
      at.getUTCMonth(),
      at.getUTCDate(),
    ));
    return {
      kind,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 24 * 60 * 60 * 1_000),
    };
  }

  if (kind === "calendar_month") {
    return {
      kind,
      startsAt: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)),
      endsAt: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1)),
    };
  }

  return {
    kind,
    startsAt: new Date("1970-01-01T00:00:00.000Z"),
    endsAt: new Date("9999-12-31T23:59:59.999Z"),
  };
}
