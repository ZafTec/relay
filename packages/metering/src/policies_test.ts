import { assertEquals, assertThrows } from "@std/assert";
import {
  calculateProviderCost,
  estimateMeteredUsage,
  parseMeterPolicyDocument,
  settlementActionFor,
} from "./policies.ts";

const METER_FIXTURE = {
  schemaVersion: 1,
  metric: "fixture.compute_units",
  unit: "fixture_unit",
  period: "calendar_month",
  estimate: {
    base: "0.25",
    terms: [{ measure: "requested_units", rate: "1.5" }],
  },
  reservation: { multiplier: "1.2", minimum: "1" },
  settlement: {
    success: "commit_actual",
    partial_output: "commit_actual",
    validation_rejected: "release",
    safety_rejected: "commit_actual",
    provider_failure: "release",
    cancelled: "release",
    timed_out: "release",
    storage_failure: "commit_actual",
  },
} as const;

const PRICING_FIXTURE = {
  schemaVersion: 1,
  currency: "TST",
  rates: [
    { measure: "fixture_tokens", unit: "token", pricePerUnit: "0.125" },
    { measure: "fixture_outputs", unit: "output", pricePerUnit: "0.5" },
  ],
  minimumCost: "0",
} as const;

Deno.test("meter fixture creates a conservative bounded reservation", () => {
  const estimate = estimateMeteredUsage(METER_FIXTURE, {
    requested_units: { minimum: "1", expected: "2", maximum: "3" },
  });
  assertEquals(estimate, {
    metric: "fixture.compute_units",
    unit: "fixture_unit",
    period: "calendar_month",
    minimum: "1.75",
    expected: "3.25",
    maximum: "4.75",
    reserve: "5.7",
    measures: {
      requested_units: { minimum: "1", expected: "2", maximum: "3" },
    },
  });
});

Deno.test("meter fixture makes terminal settlement policy explicit", () => {
  assertEquals(settlementActionFor(METER_FIXTURE, "success"), "commit_actual");
  assertEquals(
    settlementActionFor(METER_FIXTURE, "partial_output"),
    "commit_actual",
  );
  assertEquals(
    settlementActionFor(METER_FIXTURE, "provider_failure"),
    "release",
  );
  assertEquals(settlementActionFor(METER_FIXTURE, "cancelled"), "release");
  assertEquals(settlementActionFor(METER_FIXTURE, "timed_out"), "release");
});

Deno.test("pricing fixture calculates provider cost independently of customer usage", () => {
  assertEquals(
    calculateProviderCost(PRICING_FIXTURE, {
      fixture_tokens: { quantity: "3", unit: "token" },
      fixture_outputs: { quantity: "2", unit: "output" },
    }),
    {
      currency: "TST",
      amount: "1.375",
      components: [
        {
          measure: "fixture_tokens",
          unit: "token",
          quantity: "3",
          pricePerUnit: "0.125",
          amount: "0.375",
        },
        {
          measure: "fixture_outputs",
          unit: "output",
          quantity: "2",
          pricePerUnit: "0.5",
          amount: "1",
        },
      ],
    },
  );
});

Deno.test("policy parsing fails closed on unknown fields and non-conservative reserve", () => {
  assertThrows(() =>
    parseMeterPolicyDocument({
      ...METER_FIXTURE,
      displayPlanName: "not allowed in core policy",
    })
  );
  assertThrows(() =>
    parseMeterPolicyDocument({
      ...METER_FIXTURE,
      reservation: { multiplier: "0.99", minimum: "0" },
    })
  );
});
