import { assertEquals, assertStringIncludes } from "@std/assert";
import { CANONICAL_SQL, migration } from "./0025_scheduler_profiles.ts";
import { sha256Hex } from "./checksum.ts";

Deno.test("0025_scheduler_profiles checksum matches its canonical SQL", async () => {
  assertEquals(await sha256Hex(CANONICAL_SQL), migration.checksumSha256);
});

Deno.test("0025_scheduler_profiles makes job class assignment server-owned", () => {
  for (const classKey of ["standard", "paid", "enterprise", "internal"]) {
    assertStringIncludes(CANONICAL_SQL, `'${classKey}'`);
  }
  assertStringIncludes(
    CANONICAL_SQL,
    "execution_jobs_server_owned_scheduling_profile",
  );
  assertStringIncludes(
    CANONICAL_SQL,
    "foreign key (scheduling_class) references relay.scheduler_classes",
  );
  assertStringIncludes(
    CANONICAL_SQL,
    "revoke insert, update, delete on relay.workspace_scheduling_profiles from relay_app",
  );
  assertStringIncludes(
    CANONICAL_SQL,
    "revoke all on function relay.set_workspace_scheduling_profile(text, text, text, timestamptz) from relay_app",
  );
  assertEquals(
    CANONICAL_SQL.includes(
      "grant execute on function relay.set_workspace_scheduling_profile",
    ),
    false,
  );
});

Deno.test("0025_scheduler_profiles enforces immutable monotonic revisions", () => {
  assertStringIncludes(CANONICAL_SQL, "unique (class_key, policy_version)");
  assertStringIncludes(CANONICAL_SQL, "scheduler_classes_revision_guard");
  assertStringIncludes(
    CANONICAL_SQL,
    "scheduler policy changes require a newer policy version",
  );
  assertStringIncludes(CANONICAL_SQL, "on update cascade");
  assertStringIncludes(CANONICAL_SQL, "for key share");
  assertStringIncludes(
    CANONICAL_SQL,
    "and classes.policy_version = profile.policy_version",
  );
});
