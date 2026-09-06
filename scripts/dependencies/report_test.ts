import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  actionDependencies,
  endMarker,
  findUpdates,
  isNewer,
  issueTitle,
  npmDependencies,
  publishReport,
  renderReport,
  replaceReport,
  startMarker,
  type Update,
} from "./report.ts";

const update: Update = {
  ecosystem: "npm",
  name: "better-auth",
  current: "1.7.1",
  latest: "1.7.2",
  files: ["apps/web/package.json"],
};

Deno.test("dependency versions compare numerically and reject unsupported tags", () => {
  assertEquals(isNewer("1.9.0", "v1.10.0"), true);
  assertEquals(isNewer("v2.0.0", "2.0.0"), false);
  assertEquals(isNewer("2.0.0", "1.99.99"), false);
  assertThrows(() => isNewer("1.0.0", "2.0.0-beta.1"));
  assertThrows(() => npmDependencies({ dependencies: { example: "^1.0.0" } }));
});

Deno.test("action inventory deduplicates pins and preserves affected workflow paths", () => {
  const pin = "actions/checkout@" + "a".repeat(40);
  const dependencies = actionDependencies([
    { path: ".github/workflows/ci.yml", source: `    uses: ${pin} # v7.0.1\n` },
    {
      path: ".github/workflows/release.yml",
      source: `  - uses: ${pin} # 7.0.1\n  - uses: ./local\n`,
    },
  ]);
  assertEquals(dependencies, [{
    ecosystem: "GitHub Actions",
    name: "actions/checkout",
    current: "7.0.1",
    files: [".github/workflows/ci.yml", ".github/workflows/release.yml"],
  }]);
  assertThrows(() =>
    actionDependencies([
      { path: "ci.yml", source: "uses: actions/checkout@v7" },
    ])
  );
});

Deno.test("dependency lookups omit current versions and fail on incomplete results", async () => {
  const dependencies = npmDependencies({
    dependencies: { older: "1.0.0", current: "2.0.0" },
  });
  assertEquals(
    await findUpdates(dependencies, () => Promise.resolve("2.0.0")),
    [{
      ...dependencies[0],
      latest: "2.0.0",
    }],
  );
  await assertRejects(
    () =>
      findUpdates(dependencies, (dependency) => {
        if (dependency.name === "current") {
          throw new Error("registry unavailable");
        }
        return Promise.resolve("2.0.0");
      }),
    Error,
    "registry unavailable",
  );
});

Deno.test("report publishing creates an issue only when updates exist", async () => {
  const writes: unknown[] = [];
  const request = (_path: string, method = "GET", body?: unknown) => {
    if (method !== "GET") writes.push({ method, body });
    return Promise.resolve([]);
  };
  await publishReport(request, "ZafTec/relay", []);
  assertEquals(writes, []);
  await publishReport(request, "ZafTec/relay", [update]);
  assertEquals(writes, [{
    method: "POST",
    body: { title: issueTitle, body: renderReport([update]) },
  }]);
});

Deno.test("report refresh finds later pages, preserves review notes, and avoids duplicate writes", async () => {
  const report = renderReport([update]);
  const body = `Review notes before.\n${report}\nPending manual review after.`;
  const writes: unknown[] = [];
  const unrelated = { number: 1, title: "Other", body: "Other issue" };
  const request = (path: string, method = "GET", payload?: unknown) => {
    if (method !== "GET") {
      writes.push({ path, method, payload });
      return Promise.resolve({});
    }
    if (path.endsWith("page=1")) {
      return Promise.resolve(Array(100).fill(unrelated));
    }
    return Promise.resolve([{ number: 37, title: issueTitle, body }]);
  };
  await publishReport(request, "ZafTec/relay", [update]);
  assertEquals(writes, []);
  await publishReport(request, "ZafTec/relay", []);
  assertEquals(writes, [{
    path: "/repos/ZafTec/relay/issues/37",
    method: "PATCH",
    payload: {
      body: `Review notes before.\n${
        renderReport([])
      }\nPending manual review after.`,
    },
  }]);
});

Deno.test("malformed or duplicate issue markers stop publication without overwriting notes", async () => {
  assertThrows(() =>
    replaceReport(
      `${startMarker}\nNotes without the end marker`,
      renderReport([]),
    )
  );
  const writes: unknown[] = [];
  const request = (_path: string, method = "GET", body?: unknown) => {
    if (method !== "GET") writes.push(body);
    return Promise.resolve([1, 2].map((number) => ({
      number,
      title: issueTitle,
      body: `${startMarker}\n${endMarker}`,
    })));
  };
  await assertRejects(
    () => publishReport(request, "ZafTec/relay", [update]),
    Error,
    "Multiple open",
  );
  assertEquals(writes, []);
});
