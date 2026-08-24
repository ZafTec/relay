#!/usr/bin/env -S deno run --allow-env --allow-run --allow-read

/**
 * `deno task check` silently ignores every live-database/Redis test when
 * DATABASE_URL/MIGRATOR_TEST_DATABASE_URL/REDIS_URL aren't set -- exactly
 * how a normal `deno task check` run can report "40 passed, 59 ignored"
 * and look green while most of the database/auth/queue/capacity/catalog
 * behavior in the repo goes unexercised. `deno task check:live` is the
 * same check, except it refuses to run at all unless every required service
 * is configured, enables the MinIO/artifact contract lanes, and then fails
 * loudly if any test still reports itself ignored. A skipped test in this
 * mode means the disposable PostgreSQL/Redis/MinIO stack or one of its
 * credentials is incomplete, not that infrastructure was intentionally absent.
 */

const REQUIRED_ENV_VARS = [
  "DATABASE_URL",
  "MIGRATOR_TEST_DATABASE_URL",
  "REDIS_URL",
] as const;

const missing = REQUIRED_ENV_VARS.filter((name) =>
  Deno.env.get(name) === undefined
);
if (missing.length > 0) {
  console.error(
    `deno task check:live requires ${
      REQUIRED_ENV_VARS.join(", ")
    } to all be set (missing: ${missing.join(", ")}).\n` +
      `See .env.example -- DATABASE_URL connects as relay_app against the ` +
      `real dev database, MIGRATOR_TEST_DATABASE_URL against the disposable ` +
      `relay_test database, REDIS_URL against the dev Redis instance.`,
  );
  Deno.exit(1);
}

// Privileged auth migration tests use the migrator identity against the same
// database as the runtime suite. Deriving this URL keeps one authoritative
// application database while preserving the separate destructive migrator
// database used by packages/database/src/migrator_test.ts.
const runtimeUrl = new URL(Deno.env.get("DATABASE_URL")!);
const migratorUrl = new URL(Deno.env.get("MIGRATOR_TEST_DATABASE_URL")!);

if (Deno.env.get("AUTH_SECURITY_TEST_DATABASE_URL") === undefined) {
  const privilegedRuntimeUrl = new URL(runtimeUrl);
  privilegedRuntimeUrl.username = migratorUrl.username;
  privilegedRuntimeUrl.password = migratorUrl.password;
  Deno.env.set(
    "AUTH_SECURITY_TEST_DATABASE_URL",
    privilegedRuntimeUrl.toString(),
  );
}

Deno.env.set("RUN_MINIO_CONTRACT_TESTS", "1");
Deno.env.set("RUN_ARTIFACT_CONTRACT_TESTS", "1");

async function run(cmd: string, args: string[]): Promise<void> {
  const command = new Deno.Command(cmd, {
    args,
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await command.output();
  if (code !== 0) Deno.exit(code);
}

await run(Deno.execPath(), ["fmt", "--check", "apps", "packages", "src"]);
await run(Deno.execPath(), ["lint", "apps", "packages", "src"]);
await run(Deno.execPath(), ["check", "src/main.ts"]);

const testCommand = new Deno.Command(Deno.execPath(), {
  args: ["test", "--allow-env", "--allow-net"],
  stdout: "piped",
  stderr: "inherit",
});
const testProcess = testCommand.spawn();

const chunks: Uint8Array[] = [];
const teeToStdout = testProcess.stdout.pipeThrough(
  new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      chunks.push(chunk);
      controller.enqueue(chunk);
    },
  }),
);
await teeToStdout.pipeTo(Deno.stdout.writable, { preventClose: true });
const { code: testCode } = await testProcess.status;

const output = new TextDecoder().decode(
  chunks.reduce((acc, chunk) => {
    const merged = new Uint8Array(acc.length + chunk.length);
    merged.set(acc);
    merged.set(chunk, acc.length);
    return merged;
  }, new Uint8Array()),
);

const ignoredMatch = output.match(/(\d+) ignored/);
const ignoredCount = ignoredMatch ? Number(ignoredMatch[1]) : 0;

if (testCode !== 0) {
  Deno.exit(testCode);
}

if (ignoredCount > 0) {
  console.error(
    `deno task check:live: ${ignoredCount} test(s) were still ignored even ` +
      `though the live PostgreSQL, Redis, and MinIO lanes were enabled. ` +
      `Check compose.dev.yaml, including the dedicated relay_test database.`,
  );
  Deno.exit(1);
}

console.log(
  "deno task check:live: all live-infrastructure tests ran (0 ignored).",
);
