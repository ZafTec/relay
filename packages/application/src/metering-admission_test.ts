import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import type {
  AdmissionReservationResult,
  EstimateUsageResult,
} from "@relay/metering";
import type {
  AdmissionUsagePort,
  AdmissionUsageQuote,
  AdmissionUsageRequest,
} from "@relay/queue";
import {
  MAX_ADMISSION_RESERVATION_TTL_SECONDS,
  PostgresAdmissionUsagePort,
  type PostgresAdmissionUsagePortDependencies,
  resolveAdmissionUsageMeasures,
  runAdmissionReservationIdempotencyKey,
  schedulerCostFromExpectedUsage,
} from "./metering-admission.ts";

const HASH = "a".repeat(64);
const RESERVATION_ID = "reservation_0123456789abcdef0123456789abcdef";
const POLICY = {
  id: "meter_policy_test",
  key: "images.generated",
  revision: 7,
  immutableHash: HASH,
} as const;

function request(
  input: unknown = { prompt: "mountain", n: 3 },
): AdmissionUsageRequest {
  return {
    workspaceId: "workspace_test",
    toolVersionId: "tver_0123456789abcdef0123456789abcdef",
    createdBy: "user_test",
    input,
    runIdempotencyKey: "run-request-1",
    route: {
      route: {
        toolId: "tool_0123456789abcdef0123456789abcdef",
        providerModelId: "42",
      },
    },
    schedulingProfile: {},
  } as unknown as AdmissionUsageRequest;
}

function clientFor(toolKey: string, calls: string[] = []) {
  return {
    query<Row>(text: string): Promise<{ rows: Row[] }> {
      calls.push(text);
      if (text === "select key from relay.tools where id = $1") {
        return Promise.resolve({ rows: [{ key: toolKey }] as Row[] });
      }
      if (
        text.startsWith("savepoint relay_metering_probe_") ||
        text.startsWith("release savepoint relay_metering_probe_")
      ) {
        return Promise.resolve({ rows: [] });
      }
      throw new Error(`unexpected query: ${text}`);
    },
  } as unknown as Parameters<AdmissionUsagePort["quote"]>[0];
}

function estimated(
  measures: NonNullable<AdmissionUsageQuote["measures"]>,
  expected = "2.500000000",
): EstimateUsageResult {
  return {
    kind: "estimated",
    estimate: {
      metric: "images.generated",
      unit: "image",
      period: "calendar_month",
      minimum: expected,
      expected,
      maximum: expected,
      reserve: expected,
      measures,
    },
    meterPolicy: {
      ...POLICY,
      document: {} as never,
    },
    entitlement: {} as never,
    limitAmount: "100",
  };
}

function reservation(
  kind: "reserved" | "replayed",
  quote: AdmissionUsageQuote,
): AdmissionReservationResult {
  return {
    kind,
    reservation: {
      reservationId: RESERVATION_ID,
      meterPolicy: { ...POLICY, document: {} },
      estimate: { measures: quote.measures },
    },
    remainingAmount: "97.5",
  } as unknown as AdmissionReservationResult;
}

Deno.test("admission measures parse GPT n and keep fixed-count tools deterministic", () => {
  assertEquals(
    resolveAdmissionUsageMeasures("image.generate.gpt-image-2", {
      prompt: "one",
    }),
    {
      requested_units: { minimum: "1", expected: "1", maximum: "1" },
    },
  );
  assertEquals(
    resolveAdmissionUsageMeasures("image.generate.gpt-image-2", {
      prompt: "three",
      n: 3,
    }),
    {
      requested_units: { minimum: "3", expected: "3", maximum: "3" },
    },
  );
  for (const toolKey of ["image.generate.flux-2-pro", "document.ocr"]) {
    assertEquals(resolveAdmissionUsageMeasures(toolKey, {}), {
      requested_units: { minimum: "1", expected: "1", maximum: "1" },
    });
  }
  for (const n of [0, 11, 1.5, "2", null]) {
    assertThrows(
      () => resolveAdmissionUsageMeasures("image.generate.gpt-image-2", { n }),
      TypeError,
    );
  }
  assertThrows(
    () => resolveAdmissionUsageMeasures("unknown.tool", {}),
    TypeError,
  );
});

Deno.test("scheduler cost uses expected usage and remains bounded", () => {
  assertEquals(schedulerCostFromExpectedUsage("0"), 1);
  assertEquals(schedulerCostFromExpectedUsage("0.500000000"), 1);
  assertEquals(schedulerCostFromExpectedUsage("2.500000000"), 2.5);
  assertEquals(schedulerCostFromExpectedUsage("100000000000000000000"), 10_000);
  assertThrows(() => schedulerCostFromExpectedUsage("NaN"), TypeError);
});

Deno.test("Postgres admission quote uses the selected tool, model, and policy identity", async () => {
  let estimateInput: unknown;
  const dependencies: PostgresAdmissionUsagePortDependencies = {
    estimateUsage: ((_client, input) => {
      estimateInput = input;
      return Promise.resolve(estimated(input.measures as never));
    }) as PostgresAdmissionUsagePortDependencies["estimateUsage"],
    reserveUsageForAdmission: (() => {
      throw new Error("reserve must not run while quoting");
    }) as PostgresAdmissionUsagePortDependencies["reserveUsageForAdmission"],
  };
  const port = new PostgresAdmissionUsagePort({}, dependencies);
  const result = await port.quote(
    clientFor("image.generate.gpt-image-2"),
    request(),
  );

  assertEquals(result, {
    estimatedCostUnits: 2.5,
    policyKey: `meter:${POLICY.key}:r${POLICY.revision}:${HASH}`,
    measures: {
      requested_units: { minimum: "3", expected: "3", maximum: "3" },
    },
  });
  assertEquals(estimateInput, {
    actorUserId: "user_test",
    workspaceId: "workspace_test",
    toolVersionId: "tver_0123456789abcdef0123456789abcdef",
    providerModelId: "42",
    measures: {
      requested_units: { minimum: "3", expected: "3", maximum: "3" },
    },
  });
});

Deno.test("Postgres admission reserve reuses measures and domain-separates replays", async () => {
  const quote: AdmissionUsageQuote = {
    estimatedCostUnits: 3,
    policyKey: `meter:${POLICY.key}:r${POLICY.revision}:${HASH}`,
    measures: resolveAdmissionUsageMeasures("image.generate.gpt-image-2", {
      n: 3,
    }),
  };
  const reserveInputs: unknown[] = [];
  let attempts = 0;
  const dependencies: PostgresAdmissionUsagePortDependencies = {
    estimateUsage: (() => {
      throw new Error("estimate must not run while reserving");
    }) as PostgresAdmissionUsagePortDependencies["estimateUsage"],
    reserveUsageForAdmission: ((_transaction, input) => {
      reserveInputs.push(input);
      attempts += 1;
      return Promise.resolve(
        reservation(attempts === 1 ? "reserved" : "replayed", quote),
      );
    }) as PostgresAdmissionUsagePortDependencies["reserveUsageForAdmission"],
  };
  const calls: string[] = [];
  const port = new PostgresAdmissionUsagePort(
    { reservationTtlSeconds: 900 },
    dependencies,
  );
  const admissionRequest = request();

  assertEquals(
    await port.reserve(clientFor("unused", calls), admissionRequest, quote),
    RESERVATION_ID,
  );
  assertEquals(
    await port.reserve(clientFor("unused", calls), admissionRequest, quote),
    RESERVATION_ID,
  );
  assertEquals(reserveInputs.length, 2);
  for (const rawInput of reserveInputs) {
    const input = rawInput as {
      readonly measures: unknown;
      readonly idempotencyKey: string;
      readonly reservationTtlSeconds: number;
    };
    assertStrictEquals(input.measures, quote.measures);
    assertEquals(
      input.idempotencyKey,
      runAdmissionReservationIdempotencyKey("run-request-1"),
    );
    assertEquals(input.reservationTtlSeconds, 900);
  }
  assertEquals(
    calls.filter((sql) => sql.startsWith("savepoint ")).length,
    2,
  );
  assertEquals(
    calls.filter((sql) => sql.startsWith("release savepoint ")).length,
    2,
  );
});

Deno.test("Postgres admission port maps metering failures without leaking internals", async () => {
  const failures: Array<{
    readonly metering: EstimateUsageResult;
    readonly expected: unknown;
  }> = [
    {
      metering: { kind: "not_entitled" },
      expected: { kind: "not_entitled" },
    },
    {
      metering: { kind: "workspace_unavailable" },
      expected: { kind: "usage_unavailable", reason: "unavailable" },
    },
    {
      metering: { kind: "metering_not_configured" },
      expected: {
        kind: "usage_unavailable",
        reason: "invalid_configuration",
      },
    },
    {
      metering: { kind: "invalid_configuration" },
      expected: {
        kind: "usage_unavailable",
        reason: "invalid_configuration",
      },
    },
  ];

  for (const fixture of failures) {
    const port = new PostgresAdmissionUsagePort({}, {
      estimateUsage: (() =>
        Promise.resolve(
          fixture.metering,
        )) as PostgresAdmissionUsagePortDependencies["estimateUsage"],
      reserveUsageForAdmission: (() => {
        throw new Error("reserve must not run after quote failure");
      }) as PostgresAdmissionUsagePortDependencies["reserveUsageForAdmission"],
    });
    assertEquals(
      await port.quote(clientFor("image.generate.gpt-image-2"), request()),
      fixture.expected,
    );
  }

  const quote: AdmissionUsageQuote = {
    estimatedCostUnits: 1,
    policyKey: `meter:${POLICY.key}:r${POLICY.revision}:${HASH}`,
    measures: resolveAdmissionUsageMeasures("document.ocr", {}),
  };
  const allowance = {
    kind: "allowance_exceeded",
    metric: "documents.processed",
    unit: "request",
    limitAmount: "10",
    consumedAmount: "7",
    reservedAmount: "2",
    requestedAmount: "1",
  } as const;
  const port = new PostgresAdmissionUsagePort({}, {
    estimateUsage: (() =>
      Promise.resolve(
        estimated(quote.measures!),
      )) as PostgresAdmissionUsagePortDependencies["estimateUsage"],
    reserveUsageForAdmission: (() =>
      Promise.resolve(allowance)) as PostgresAdmissionUsagePortDependencies[
        "reserveUsageForAdmission"
      ],
  });
  assertEquals(
    await port.reserve(clientFor("unused"), request({}), quote),
    allowance,
  );

  const unsafePort = new PostgresAdmissionUsagePort({}, {
    estimateUsage: (() =>
      Promise.resolve(
        estimated(quote.measures!),
      )) as PostgresAdmissionUsagePortDependencies["estimateUsage"],
    reserveUsageForAdmission: (() =>
      Promise.resolve({
        ...allowance,
        metric: "https://internal.example/secret",
      })) as PostgresAdmissionUsagePortDependencies["reserveUsageForAdmission"],
  });
  assertEquals(
    await unsafePort.reserve(clientFor("unused"), request({}), quote),
    { kind: "usage_unavailable", reason: "invalid_configuration" },
  );

  assertThrows(
    () =>
      new PostgresAdmissionUsagePort({
        reservationTtlSeconds: MAX_ADMISSION_RESERVATION_TTL_SECONDS + 1,
      }),
    RangeError,
  );
});

Deno.test("Postgres admission reserve rejects a policy mismatch", async () => {
  const quote: AdmissionUsageQuote = {
    estimatedCostUnits: 1,
    policyKey: `meter:${POLICY.key}:r${POLICY.revision}:${HASH}`,
    measures: resolveAdmissionUsageMeasures("document.ocr", {}),
  };
  const original = reservation("reserved", quote) as unknown as {
    readonly kind: "reserved";
    readonly reservation: Readonly<Record<string, unknown>>;
    readonly remainingAmount: string;
  };
  const mismatched = {
    ...original,
    reservation: {
      ...original.reservation,
      meterPolicy: {
        ...POLICY,
        revision: POLICY.revision + 1,
        document: {},
      },
    },
  } as unknown as AdmissionReservationResult;
  const port = new PostgresAdmissionUsagePort({}, {
    estimateUsage: (() =>
      Promise.resolve(
        estimated(quote.measures!),
      )) as PostgresAdmissionUsagePortDependencies["estimateUsage"],
    reserveUsageForAdmission: (() =>
      Promise.resolve(mismatched)) as PostgresAdmissionUsagePortDependencies[
        "reserveUsageForAdmission"
      ],
  });

  await assertRejects(
    () => port.reserve(clientFor("unused"), request({}), quote),
    Error,
    "does not match",
  );
});
