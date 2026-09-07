import { assertEquals, assertThrows } from "@std/assert";
import { storageUsageSummarySchema } from "./storage-usage.ts";

const storage = {
  generatedAt: "2026-09-07T12:00:00.000Z",
  storedBytes: "9007199254740993",
  reservedBytes: "7",
  cleanupPendingBytes: "2",
  limitBytes: "9007199254741010",
  availableBytes: "10",
};

Deno.test("storage contract preserves integer bytes and rejects imprecise or inconsistent summaries", () => {
  assertEquals(storageUsageSummarySchema.parse(storage), storage);
  for (
    const invalid of [
      { ...storage, storedBytes: 9007199254740993 },
      { ...storage, storedBytes: "-1" },
      { ...storage, storedBytes: "01" },
      { ...storage, storedBytes: "1.5" },
      { ...storage, storedBytes: "9223372036854775808" },
      { ...storage, cleanupPendingBytes: "8" },
      { ...storage, availableBytes: "12" },
      { ...storage, limitBytes: null },
    ]
  ) assertThrows(() => storageUsageSummarySchema.parse(invalid), TypeError);
  assertEquals(
    storageUsageSummarySchema.parse({
      ...storage,
      limitBytes: "1",
      availableBytes: "0",
    }).availableBytes,
    "0",
  );
  assertEquals(
    storageUsageSummarySchema.parse({
      ...storage,
      limitBytes: null,
      availableBytes: null,
    }).limitBytes,
    null,
  );
});
