import { assertEquals, assertThrows } from "@std/assert";
import {
  addDecimalAmounts,
  compareDecimalAmounts,
  multiplyDecimalAmounts,
  normalizeDecimalAmount,
  subtractDecimalAmounts,
} from "./decimal.ts";

Deno.test("decimal amounts stay exact and canonical", () => {
  assertEquals(normalizeDecimalAmount("0"), "0");
  assertEquals(normalizeDecimalAmount("12.340000000"), "12.34");
  assertEquals(addDecimalAmounts(["0.1", "0.2"]), "0.3");
  assertEquals(subtractDecimalAmounts("10", "3.25"), "6.75");
  assertEquals(compareDecimalAmounts("1.000000000", "1"), 0);
});

Deno.test("decimal multiplication exposes conservative ceiling rounding", () => {
  assertEquals(
    multiplyDecimalAmounts("1.000000001", "1.1", "floor"),
    "1.100000001",
  );
  assertEquals(
    multiplyDecimalAmounts("1.000000001", "1.1", "ceil"),
    "1.100000002",
  );
});

Deno.test("decimal amounts reject exponent, excess precision, and unsafe range", () => {
  assertThrows(() => normalizeDecimalAmount("000"));
  assertThrows(() => normalizeDecimalAmount("1e3"));
  assertThrows(() => normalizeDecimalAmount("0.0000000001"));
  assertThrows(() => normalizeDecimalAmount("-1"));
  assertThrows(() =>
    normalizeDecimalAmount("100000000000000000000000000000.000000000")
  );
});
