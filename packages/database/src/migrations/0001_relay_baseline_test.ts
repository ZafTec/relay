import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "@std/assert";
import pg from "pg";
import {
  estimateMeteredUsage,
  parseMeterPolicyDocument,
} from "@relay/metering";
import { CANONICAL_SQL, migration } from "./0001_relay_baseline.ts";
import { sha256Hex } from "./checksum.ts";
import { MIGRATIONS } from "./manifest.ts";

Deno.test("0001_relay_baseline checksum matches its canonical SQL", async () => {
  assertEquals(await sha256Hex(CANONICAL_SQL), migration.checksumSha256);
});

Deno.test("0001 baseline contains the complete MVP trust boundaries", () => {
  for (
    const invariant of [
      'CREATE TABLE auth."user"',
      "CREATE TABLE auth.jwks",
      'CREATE TABLE auth."oauthClient"',
      'CREATE TABLE auth."oauthResource"',
      'CREATE TABLE auth."oauthClientResource"',
      'CREATE TABLE auth."oauthRefreshToken"',
      'CREATE TABLE auth."oauthAccessToken"',
      'CREATE TABLE auth."oauthConsent"',
      'CREATE TABLE auth."oauthClientAssertion"',
      "CREATE TABLE relay.tool_runs",
      "CREATE TABLE relay.execution_jobs",
      "CREATE TABLE relay.artifacts",
      "CREATE TABLE relay.usage_reservations",
      "CREATE TABLE relay.changelog_releases",
      "CREATE FUNCTION relay.record_audit_event",
      "CREATE FUNCTION relay.adjust_customer_usage",
      "CREATE TRIGGER execution_jobs_server_owned_scheduling_profile",
      "REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA relay FROM relay_app",
      "INSERT INTO relay.scheduler_classes",
      "'capacity_policy.revise'::text",
      "CREATE TRIGGER governance_operation_idempotency_immutable",
      "CREATE TRIGGER entitlement_grants_mutation_guard",
      "GRANT SELECT,INSERT ON TABLE relay.governance_operation_idempotency TO relay_app",
      "GRANT SELECT,INSERT ON TABLE relay.entitlement_grants TO relay_app",
      "GRANT EXECUTE ON FUNCTION relay.require_fresh_superadmin_session(p_operator_session_id text) TO relay_app",
    ]
  ) {
    assertStringIncludes(CANONICAL_SQL, invariant);
  }
  assertEquals(
    /INSERT INTO relay\.pricing_policies/i.test(CANONICAL_SQL),
    false,
  );
  assertEquals(
    /^GRANT[^;]*(?:UPDATE|DELETE)[^;]*ON TABLE relay\.entitlement_grants/im
      .test(
        CANONICAL_SQL,
      ),
    false,
  );
  assertEquals(
    /^GRANT[^;]*(?:UPDATE|DELETE)[^;]*ON TABLE relay\.governance_operation_idempotency/im
      .test(CANONICAL_SQL),
    false,
  );
});

const SEEDED_TOOL_KEYS = [
  "document.ocr",
  "image.generate.flux-2-pro",
  "image.generate.gpt-image-2",
] as const;

const IMAGE_METER_POLICY_ID = "meter_c4cb2884f8474160fa2b61d5c6fb9c46";
const OCR_METER_POLICY_ID = "meter_ebafb531114359dfe541f419b0c5bc13";
const MVP_ENTITLEMENT_SOURCE = "relay.mvp.defaults.v1";

function jsonDocuments(): Array<Record<string, unknown>> {
  return [...CANONICAL_SQL.matchAll(/\$json\$\s*([\s\S]*?)\$json\$/g)].map(
    (match) => JSON.parse(match[1]) as Record<string, unknown>,
  );
}

function schemaById(id: string): Record<string, unknown> {
  const schema = jsonDocuments().find((document) => document.$id === id);
  assertExists(schema, `missing schema ${id}`);
  return schema;
}

function propertiesOf(
  schema: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const properties = schema.properties;
  assert(
    properties !== null && typeof properties === "object" &&
      !Array.isArray(properties),
  );
  return properties as Record<string, Record<string, unknown>>;
}

Deno.test("0001 baseline is the only manifest migration", () => {
  assertEquals(migration.transactional, true);
  assertEquals(
    MIGRATIONS.map((entry) => entry.id),
    ["0001_relay_baseline"],
  );
  assertEquals(
    MIGRATIONS.filter((entry) => entry.id === migration.id).length,
    1,
  );

  assertEquals(
    /CREATE\s+(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS/i.test(CANONICAL_SQL),
    false,
  );
  const fixedSeedOffset = CANONICAL_SQL.indexOf(
    "-- Fixed public IDs are SHA-256-derived opaque identifiers",
  );
  assert(fixedSeedOffset >= 0);
  assertEquals(
    /\bON\s+CONFLICT\b/i.test(CANONICAL_SQL.slice(fixedSeedOffset)),
    false,
  );
});

Deno.test("0001 baseline contains the durable MVP storage and safety surface", () => {
  for (
    const invariant of [
      "CREATE TABLE relay.artifact_storage_accounts",
      "CREATE TABLE relay.artifact_storage_reservations",
      "CREATE TABLE relay.artifact_mutation_idempotency",
      "ADD COLUMN token_key_version integer;",
      "Existing random-token links remain resolvable by hash",
      "NEW.token_key_version",
      "ADD COLUMN purge_available_at timestamp with time zone",
      "CREATE INDEX artifacts_purge_retry_idx",
      "ADD COLUMN failure_code text",
      "job_attempts_submission_state_check",
      "job_attempts_submission_evidence_check",
      "job_attempts_ambiguous_terminal_check",
      "job_attempts_ambiguous_retry_check",
      "artifact_storage_reservations_transition_guard",
      "artifact_mutation_idempotency_immutable",
      "^aqr_[0-9a-f]{32}$",
      "'create_upload'::text, 'complete_upload'::text, 'create_share'::text, 'revoke_share'::text",
      "GRANT SELECT, INSERT ON TABLE relay.artifact_mutation_idempotency TO relay_app",
    ]
  ) {
    assertStringIncludes(CANONICAL_SQL, invariant);
  }

  assertEquals(
    /ADD COLUMN token_key_version integer[^;]*(?:DEFAULT|NOT NULL)/i.test(
      CANONICAL_SQL,
    ),
    false,
  );
  assertEquals(
    /GRANT[^;]*DELETE[^;]*artifact_mutation_idempotency/i.test(CANONICAL_SQL),
    false,
  );
  assertEquals(
    /GRANT[^;]*UPDATE[^;]*artifact_mutation_idempotency/i.test(CANONICAL_SQL),
    false,
  );
});

Deno.test("0001 baseline seeds strict complete input contracts", () => {
  const gpt = schemaById(
    "urn:relay:tool:image.generate.gpt-image-2:input:1",
  );
  const flux = schemaById(
    "urn:relay:tool:image.generate.flux-2-pro:input:1",
  );
  const ocr = schemaById("urn:relay:tool:document.ocr:input:1");

  for (const schema of [gpt, flux, ocr]) {
    assertEquals(
      schema.$schema,
      "https://json-schema.org/draft/2020-12/schema",
    );
    assertEquals(schema.type, "object");
    assertEquals(schema.additionalProperties, false);
  }

  const gptProperties = propertiesOf(gpt);
  assertEquals(Object.keys(gptProperties).sort(), [
    "background",
    "moderation",
    "n",
    "outputCompression",
    "outputFormat",
    "prompt",
    "quality",
    "size",
  ]);
  assertEquals(gpt.required, ["prompt"]);
  assertEquals(gptProperties.prompt.maxLength, 32_000);
  assertEquals(gptProperties.n.minimum, 1);
  assertEquals(gptProperties.n.maximum, 10);
  assertEquals(gptProperties.outputCompression.minimum, 0);
  assertEquals(gptProperties.outputCompression.maximum, 100);
  assertEquals(gptProperties.quality.enum, ["low", "medium", "high"]);
  assertEquals(gptProperties.outputFormat.enum, ["png", "jpeg"]);
  assertEquals(gptProperties.background.enum, [
    "auto",
    "transparent",
    "opaque",
  ]);
  assertEquals(gptProperties.moderation.enum, ["auto", "low"]);

  const fluxProperties = propertiesOf(flux);
  assertEquals(Object.keys(fluxProperties).sort(), [
    "disablePromptUpsampling",
    "height",
    "inputArtifactVersionIds",
    "outputFormat",
    "prompt",
    "safetyTolerance",
    "seed",
    "width",
  ]);
  assertEquals(flux.required, ["prompt"]);
  assertEquals(fluxProperties.prompt.maxLength, 32_000);
  assertEquals(fluxProperties.inputArtifactVersionIds.minItems, 1);
  assertEquals(fluxProperties.inputArtifactVersionIds.maxItems, 8);
  assertEquals(fluxProperties.inputArtifactVersionIds.uniqueItems, true);
  assertEquals(fluxProperties.width.minimum, 64);
  assertEquals(fluxProperties.height.minimum, 64);
  assertEquals(fluxProperties.safetyTolerance.minimum, 0);
  assertEquals(fluxProperties.safetyTolerance.maximum, 5);
  assertEquals(fluxProperties.outputFormat.enum, ["jpeg", "png", "webp"]);

  const ocrProperties = propertiesOf(ocr);
  assertEquals(Object.keys(ocrProperties).sort(), [
    "confidenceGranularity",
    "extractFooter",
    "extractHeader",
    "extractionPrompt",
    "extractionSchema",
    "imageAnnotationSchema",
    "imageLimit",
    "imageMinSize",
    "includeImages",
    "pages",
    "sourceArtifactId",
    "sourceArtifactVersionId",
    "tableFormat",
  ]);
  assertEquals(ocrProperties.pages.oneOf, [
    {
      type: "string",
      minLength: 1,
      maxLength: 4096,
      pattern: "^[0-9]+(?:-[0-9]+)?(?:,[0-9]+(?:-[0-9]+)?)*$",
    },
    {
      type: "array",
      minItems: 1,
      maxItems: 1000,
      uniqueItems: true,
      items: { type: "integer", minimum: 0, maximum: 99999 },
    },
  ]);
  assertEquals(ocrProperties.imageLimit.maximum, 10_000);
  assertEquals(ocrProperties.imageMinSize.maximum, 100_000);
  assertEquals(ocrProperties.tableFormat.enum, ["markdown", "html"]);
  assertEquals(ocrProperties.confidenceGranularity.enum, ["word", "page"]);
  assertEquals(
    ocr.oneOf,
    [
      { required: ["sourceArtifactId"] },
      { required: ["sourceArtifactVersionId"] },
    ],
  );

  for (
    const id of [
      "urn:relay:tool:image.generate.gpt-image-2:output:1",
      "urn:relay:tool:image.generate.flux-2-pro:output:1",
      "urn:relay:tool:document.ocr:output:1",
    ]
  ) {
    const output = schemaById(id);
    assertEquals(output.type, "object");
    assertEquals(output.additionalProperties, false);
  }
});

Deno.test("0001 baseline seeds exact immutable MVP meter policies", () => {
  const meterSeedOffset = CANONICAL_SQL.indexOf(
    "WITH seeded_meter_policies (",
  );
  const versionSeedOffset = CANONICAL_SQL.indexOf("WITH seeded_versions (");
  assert(meterSeedOffset >= 0 && meterSeedOffset < versionSeedOffset);

  const documents = jsonDocuments().filter((document) =>
    document.metric === "images.generated" || document.metric === "ocr.requests"
  );
  assertEquals(documents.length, 2);

  const expectedSettlement = {
    success: "commit_actual",
    partial_output: "commit_actual",
    validation_rejected: "release",
    safety_rejected: "release",
    provider_failure: "release",
    cancelled: "release",
    timed_out: "release",
    storage_failure: "release",
  } as const;
  const expected = [
    { metric: "images.generated", unit: "image" },
    { metric: "ocr.requests", unit: "request" },
  ];

  for (const dimensions of expected) {
    const raw = documents.find((document) =>
      document.metric === dimensions.metric
    );
    assertExists(raw);
    const policy = parseMeterPolicyDocument(raw);
    assertEquals(policy, {
      schemaVersion: 1,
      metric: dimensions.metric,
      unit: dimensions.unit,
      period: "calendar_month",
      estimate: {
        base: "0",
        terms: [{ measure: "requested_units", rate: "1" }],
      },
      reservation: { multiplier: "1", minimum: "0" },
      settlement: expectedSettlement,
    });
    const estimate = estimateMeteredUsage(policy, {
      requested_units: { minimum: "3", expected: "3", maximum: "3" },
    });
    assertEquals(estimate.expected, "3");
    assertEquals(estimate.reserve, "3");
  }

  for (
    const invariant of [
      IMAGE_METER_POLICY_ID,
      OCR_METER_POLICY_ID,
      "relay.compute_meter_policy_immutable_hash(",
    ]
  ) {
    assertStringIncludes(CANONICAL_SQL, invariant);
  }
});

Deno.test("0001 baseline seeds fixed no-fallback catalog data without pricing", () => {
  for (
    const value of [
      "tool_d84ca194052d72d603485742598726c3",
      "tver_11916cf469e30a49a4becb0ca4b994a5",
      "tool_0cd15820ee05ddd83c2734d174f01d7b",
      "tver_d1136a97173f7ba1f2bf117a86dfa98e",
      "tool_9c347a9a7f4202d9ec92941ca4532809",
      "tver_4ce03a4c68bb39f4be709e76360eb277",
      "image.generate.azure-openai.gpt-image-2.v1",
      "image.generate.azure-flux.flux-2-pro.v1",
      "document.ocr.azure-mistral.v1",
      "relay.compute_tool_version_immutable_hash(",
      "'async'::text",
      "'public'",
      "'published'",
      "'routing':{'fallback':'none'}".replaceAll("'", '"'),
    ]
  ) {
    assertStringIncludes(CANONICAL_SQL, value);
  }

  const poolPolicies = jsonDocuments().filter((document) =>
    document.submissionRateDefaults !== undefined
  );
  assertEquals(
    poolPolicies.map((policy) =>
      (policy.submissionRateDefaults as Record<string, unknown>)
        .providerPerMinute
    ),
    [12, 4, 50],
  );
  assertEquals(
    poolPolicies.every((policy) =>
      JSON.stringify(policy.executionConcurrency) === JSON.stringify({
        globalTool: 1,
        pool: 1,
        workspaceTotal: 1,
        workspaceTool: 1,
      })
    ),
    true,
  );

  const queuePolicies = jsonDocuments().filter((document) =>
    document.globalTool === 50 && document.workspaceTotal === 20 &&
    document.workspaceTool === 5
  );
  assertEquals(queuePolicies, [
    { globalTool: 50, workspaceTotal: 20, workspaceTool: 5 },
    { globalTool: 50, workspaceTotal: 20, workspaceTool: 5 },
    { globalTool: 50, workspaceTotal: 20, workspaceTool: 5 },
  ]);

  assertEquals(
    /INSERT INTO relay\.pricing_policies/i.test(CANONICAL_SQL),
    false,
  );
  assertEquals(
    /INSERT INTO relay\.routing_policies/i.test(CANONICAL_SQL),
    false,
  );
});

const databaseUrl = Deno.env.get("DATABASE_URL");

Deno.test({
  name: "0001 baseline exposes the expected PostgreSQL runtime surface",
  ignore: databaseUrl === undefined,
  fn: async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const ledger = await client.query<{ checksum_sha256: string }>(
        `select checksum_sha256
           from relay.schema_migrations
          where id = '0001_relay_baseline'`,
      );
      assertEquals(ledger.rows, [{
        checksum_sha256: migration.checksumSha256,
      }]);

      const tables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'relay'
            and table_name in (
              'audit_events', 'tools', 'tool_versions', 'routing_decisions',
              'tool_runs', 'execution_jobs', 'outbox_events', 'artifacts',
              'artifact_versions', 'share_links', 'usage_reservations',
              'usage_events', 'provider_cost_events', 'changelog_releases',
              'legal_documents'
            )
          order by table_name`,
      );
      assertEquals(
        tables.rows.map((row: { table_name: string }) => row.table_name),
        [
          "artifact_versions",
          "artifacts",
          "audit_events",
          "execution_jobs",
          "outbox_events",
          "provider_cost_events",
          "routing_decisions",
          "share_links",
          "tool_runs",
          "tool_versions",
          "tools",
          "usage_events",
          "usage_reservations",
        ],
      );

      const authTables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'auth'
            and table_name in (
              'jwks', 'oauthClient', 'oauthResource', 'oauthClientResource',
              'oauthRefreshToken', 'oauthAccessToken', 'oauthConsent',
              'oauthClientAssertion'
            )
          order by table_name`,
      );
      assertEquals(
        authTables.rows.map((row: { table_name: string }) => row.table_name),
        [
          "jwks",
          "oauthAccessToken",
          "oauthClient",
          "oauthClientAssertion",
          "oauthClientResource",
          "oauthConsent",
          "oauthRefreshToken",
          "oauthResource",
        ],
      );

      const scheduler = await client.query<{
        class_key: string;
        weight: string;
        max_share: string | null;
      }>(
        `select class_key, weight::text, max_share::text
           from relay.scheduler_classes
          order by class_key`,
      );
      assertEquals(scheduler.rows, [
        { class_key: "enterprise", weight: "4", max_share: null },
        { class_key: "internal", weight: "1", max_share: "0.10" },
        { class_key: "paid", weight: "2", max_share: null },
        { class_key: "standard", weight: "1", max_share: null },
      ]);

      const governanceConstraint = await client.query<{
        definition: string;
      }>(
        `select pg_catalog.pg_get_constraintdef(oid) as definition
           from pg_catalog.pg_constraint
          where connamespace = 'relay'::regnamespace
            and conname = 'governance_operation_idempotency_operation_check'`,
      );
      assertEquals(governanceConstraint.rows.length, 1);
      assertStringIncludes(
        governanceConstraint.rows[0].definition,
        "capacity_policy.revise",
      );

      const privileges = await client.query<{
        audit_insert: boolean;
        role_update: boolean;
        adjustment_insert: boolean;
        changelog_select: boolean;
        run_insert: boolean;
        entitlement_select: boolean;
        entitlement_insert: boolean;
        entitlement_update: boolean;
        entitlement_delete: boolean;
        governance_select: boolean;
        governance_insert: boolean;
        governance_update: boolean;
        governance_delete: boolean;
        record_audit: boolean;
      }>(
        `select
           has_table_privilege(current_user, 'relay.audit_events', 'INSERT') as audit_insert,
           has_table_privilege(current_user, 'relay.system_role_assignments', 'UPDATE') as role_update,
           has_table_privilege(current_user, 'relay.usage_adjustments', 'INSERT') as adjustment_insert,
           has_table_privilege(current_user, 'relay.changelog_releases', 'SELECT') as changelog_select,
           has_table_privilege(current_user, 'relay.tool_runs', 'INSERT') as run_insert,
           has_table_privilege(current_user, 'relay.entitlement_grants', 'SELECT') as entitlement_select,
           has_table_privilege(current_user, 'relay.entitlement_grants', 'INSERT') as entitlement_insert,
           has_table_privilege(current_user, 'relay.entitlement_grants', 'UPDATE') as entitlement_update,
           has_table_privilege(current_user, 'relay.entitlement_grants', 'DELETE') as entitlement_delete,
           has_table_privilege(current_user, 'relay.governance_operation_idempotency', 'SELECT') as governance_select,
           has_table_privilege(current_user, 'relay.governance_operation_idempotency', 'INSERT') as governance_insert,
           has_table_privilege(current_user, 'relay.governance_operation_idempotency', 'UPDATE') as governance_update,
           has_table_privilege(current_user, 'relay.governance_operation_idempotency', 'DELETE') as governance_delete,
           has_function_privilege(
             current_user,
             'relay.record_audit_event(text,text,text,text,text,text,text,text,text,jsonb,jsonb,text,text,text,text,text,text,text)',
             'EXECUTE'
           ) as record_audit`,
      );
      assertEquals(privileges.rows[0], {
        audit_insert: false,
        role_update: false,
        adjustment_insert: false,
        changelog_select: false,
        run_insert: true,
        entitlement_select: true,
        entitlement_insert: true,
        entitlement_update: false,
        entitlement_delete: false,
        governance_select: true,
        governance_insert: true,
        governance_update: false,
        governance_delete: false,
        record_audit: true,
      });
    } finally {
      await client.end();
    }
  },
});

Deno.test({
  name: "0001 consolidated baseline exposes the added PostgreSQL MVP surface",
  ignore: databaseUrl === undefined,
  fn: async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const ledger = await client.query<{ checksum_sha256: string }>(
        `select checksum_sha256
           from relay.schema_migrations
          where id = '0001_relay_baseline'`,
      );
      assertEquals(ledger.rows, [{
        checksum_sha256: migration.checksumSha256,
      }]);

      const tables = await client.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'relay'
            and table_name in (
              'artifact_storage_accounts',
              'artifact_storage_reservations',
              'artifact_mutation_idempotency'
            )
          order by table_name`,
      );
      assertEquals(
        tables.rows.map((row: { table_name: string }) => row.table_name),
        [
          "artifact_mutation_idempotency",
          "artifact_storage_accounts",
          "artifact_storage_reservations",
        ],
      );

      const columns = await client.query<{
        table_name: string;
        column_name: string;
      }>(
        `select table_name, column_name
           from information_schema.columns
          where table_schema = 'relay'
            and (
              (table_name = 'share_links' and column_name = 'token_key_version')
              or (table_name = 'artifacts' and column_name = 'purge_available_at')
              or (table_name = 'job_attempts' and column_name = 'failure_code')
            )
          order by table_name, column_name`,
      );
      assertEquals(columns.rows, [
        { table_name: "artifacts", column_name: "purge_available_at" },
        { table_name: "job_attempts", column_name: "failure_code" },
        { table_name: "share_links", column_name: "token_key_version" },
      ]);

      const tokenColumn = await client.query<{
        is_nullable: string;
        column_default: string | null;
      }>(
        `select is_nullable, column_default
           from information_schema.columns
          where table_schema = 'relay'
            and table_name = 'share_links'
            and column_name = 'token_key_version'`,
      );
      assertEquals(tokenColumn.rows, [{
        is_nullable: "YES",
        column_default: null,
      }]);

      const constraints = await client.query<{ conname: string }>(
        `select conname
           from pg_catalog.pg_constraint
          where connamespace = 'relay'::regnamespace
            and conname in (
              'job_attempts_failure_code_check',
              'job_attempts_submission_state_check',
              'job_attempts_submission_evidence_check',
              'job_attempts_ambiguous_terminal_check',
              'job_attempts_ambiguous_retry_check',
              'share_links_token_key_version_check'
            )
          order by conname`,
      );
      assertEquals(
        constraints.rows.map((row: { conname: string }) => row.conname),
        [
          "job_attempts_ambiguous_retry_check",
          "job_attempts_ambiguous_terminal_check",
          "job_attempts_failure_code_check",
          "job_attempts_submission_evidence_check",
          "job_attempts_submission_state_check",
          "share_links_token_key_version_check",
        ],
      );

      const index = await client.query<{ indexdef: string }>(
        `select indexdef
           from pg_catalog.pg_indexes
          where schemaname = 'relay'
            and indexname = 'artifacts_purge_retry_idx'`,
      );
      assertEquals(index.rows.length, 1);
      assertStringIncludes(index.rows[0].indexdef, "purge_available_at");
      assertStringIncludes(index.rows[0].indexdef, "deleting_pending");

      const meterPolicies = await client.query<{
        id: string;
        policy_key: string;
        document: unknown;
        hash_valid: boolean;
      }>(
        `select id, policy_key, document,
                immutable_hash = relay.compute_meter_policy_immutable_hash(
                  id, policy_key, revision, document, effective_at, expires_at
                ) as hash_valid
           from relay.meter_policies
          where id = any($1::text[])
          order by policy_key`,
        [[IMAGE_METER_POLICY_ID, OCR_METER_POLICY_ID]],
      );
      assertEquals(
        meterPolicies.rows.map((row: {
          id: string;
          policy_key: string;
          document: unknown;
          hash_valid: boolean;
        }) => ({
          id: row.id,
          policyKey: row.policy_key,
          policy: parseMeterPolicyDocument(row.document),
          hashValid: row.hash_valid,
        })),
        [
          {
            id: IMAGE_METER_POLICY_ID,
            policyKey: "images.generated",
            policy: parseMeterPolicyDocument(
              jsonDocuments().find((document) =>
                document.metric === "images.generated"
              ),
            ),
            hashValid: true,
          },
          {
            id: OCR_METER_POLICY_ID,
            policyKey: "ocr.requests",
            policy: parseMeterPolicyDocument(
              jsonDocuments().find((document) =>
                document.metric === "ocr.requests"
              ),
            ),
            hashValid: true,
          },
        ],
      );

      const catalog = await client.query<{
        tool_id: string;
        tool_key: string;
        lifecycle: string;
        visibility: string;
        active_version_id: string;
        handler_key: string;
        execution_mode: string;
        hash_valid: boolean;
        meter_policy_id: string | null;
        entitlement_key: string | null;
        provider_key: string;
        provider_model_key: string;
        pricing_policy_id: string | null;
        routing_policy_id: string | null;
        capacity_pool_id: string;
        rate: unknown;
        execution_concurrency: unknown;
      }>(
        `select t.id as tool_id, t.key as tool_key, t.lifecycle, t.visibility,
                t.active_version_id, tv.handler_key, tv.execution_mode,
                tv.immutable_hash = relay.compute_tool_version_immutable_hash(
                  tv.id, tv.tool_id, tv.version, tv.input_schema,
                  tv.output_schema, tv.handler_key, tv.input_schema_version,
                  tv.handler_version, tv.execution_mode,
                  tv.max_duration_seconds, tv.meter_policy_id,
                  tv.entitlement_key, tv.compatibility_metadata
                ) as hash_valid,
                tv.meter_policy_id, tv.entitlement_key,
                provider.key as provider_key,
                model.key as provider_model_key, model.pricing_policy_id,
                binding.routing_policy_id::text,
                pool.id::text as capacity_pool_id,
                policy.configuration -> 'submissionRateDefaults' as rate,
                policy.configuration -> 'executionConcurrency'
                  as execution_concurrency
           from relay.tools t
           join relay.tool_versions tv on tv.id = t.active_version_id
           join relay.tool_provider_bindings binding
             on binding.tool_version_id = tv.id and binding.enabled
           join relay.provider_models model on model.id = binding.provider_model_id
           join relay.providers provider on provider.id = model.provider_id
           join relay.capacity_pools pool on pool.id = binding.capacity_pool_id
           join relay.capacity_policies policy
             on policy.scope_type = 'capacity_pool'
            and policy.scope_id = pool.id::text
            and policy.revision = 1
          where t.key = any($1::text[])
          order by t.key`,
        [[...SEEDED_TOOL_KEYS]],
      );
      assertEquals(
        catalog.rows.map((row: { tool_key: string }) => row.tool_key),
        [
          ...SEEDED_TOOL_KEYS,
        ],
      );
      assertEquals(
        catalog.rows.map((row: {
          lifecycle: string;
          visibility: string;
          execution_mode: string;
          hash_valid: boolean;
          meter_policy_id: string | null;
          entitlement_key: string | null;
          provider_key: string;
          provider_model_key: string;
          pricing_policy_id: string | null;
          routing_policy_id: string | null;
          rate: unknown;
          execution_concurrency: unknown;
        }) => ({
          lifecycle: row.lifecycle,
          visibility: row.visibility,
          executionMode: row.execution_mode,
          hashValid: row.hash_valid,
          meterPolicyId: row.meter_policy_id,
          entitlementKey: row.entitlement_key,
          provider: row.provider_key,
          providerModel: row.provider_model_key,
          pricingPolicyId: row.pricing_policy_id,
          routingPolicyId: row.routing_policy_id,
          requests: (row.rate as { providerPerMinute: number })
            .providerPerMinute,
          executionConcurrency: row.execution_concurrency,
        })),
        [
          {
            lifecycle: "published",
            visibility: "public",
            executionMode: "async",
            hashValid: true,
            meterPolicyId: OCR_METER_POLICY_ID,
            entitlementKey: "tools.execute",
            provider: "azure-mistral-ocr",
            providerModel: "mistral-ocr-4-0",
            pricingPolicyId: null,
            routingPolicyId: null,
            requests: 50,
            executionConcurrency: {
              globalTool: 1,
              pool: 1,
              workspaceTotal: 1,
              workspaceTool: 1,
            },
          },
          {
            lifecycle: "published",
            visibility: "public",
            executionMode: "async",
            hashValid: true,
            meterPolicyId: IMAGE_METER_POLICY_ID,
            entitlementKey: "tools.execute",
            provider: "azure-flux-2-pro",
            providerModel: "FLUX.2-pro",
            pricingPolicyId: null,
            routingPolicyId: null,
            requests: 4,
            executionConcurrency: {
              globalTool: 1,
              pool: 1,
              workspaceTotal: 1,
              workspaceTool: 1,
            },
          },
          {
            lifecycle: "published",
            visibility: "public",
            executionMode: "async",
            hashValid: true,
            meterPolicyId: IMAGE_METER_POLICY_ID,
            entitlementKey: "tools.execute",
            provider: "azure-gpt-image-2",
            providerModel: "gpt-image-2",
            pricingPolicyId: null,
            routingPolicyId: null,
            requests: 12,
            executionConcurrency: {
              globalTool: 1,
              pool: 1,
              workspaceTotal: 1,
              workspaceTool: 1,
            },
          },
        ],
      );

      assertEquals(
        catalog.rows.every((row: { tool_id: string }) =>
          /^tool_[0-9a-f]{32}$/.test(row.tool_id)
        ),
        true,
      );
      assertEquals(
        catalog.rows.every((row: { active_version_id: string }) =>
          /^tver_[0-9a-f]{32}$/.test(row.active_version_id)
        ),
        true,
      );

      const capacityPolicies = await client.query<{
        id: string;
        scope_type: string;
        scope_id: string;
        configuration: unknown;
      }>(
        `select id::text, scope_type, scope_id, configuration
           from relay.capacity_policies
          where id between 7200200500000001 and 7200200500000006
          order by id`,
      );
      assertEquals(capacityPolicies.rows, [
        {
          id: "7200200500000001",
          scope_type: "capacity_pool",
          scope_id: "7200200300000001",
          configuration: {
            submissionRateDefaults: { providerPerMinute: 12 },
            executionConcurrency: {
              globalTool: 1,
              pool: 1,
              workspaceTotal: 1,
              workspaceTool: 1,
            },
          },
        },
        {
          id: "7200200500000002",
          scope_type: "capacity_pool",
          scope_id: "7200200300000002",
          configuration: {
            submissionRateDefaults: { providerPerMinute: 4 },
            executionConcurrency: {
              globalTool: 1,
              pool: 1,
              workspaceTotal: 1,
              workspaceTool: 1,
            },
          },
        },
        {
          id: "7200200500000003",
          scope_type: "capacity_pool",
          scope_id: "7200200300000003",
          configuration: {
            submissionRateDefaults: { providerPerMinute: 50 },
            executionConcurrency: {
              globalTool: 1,
              pool: 1,
              workspaceTotal: 1,
              workspaceTool: 1,
            },
          },
        },
        {
          id: "7200200500000004",
          scope_type: "tool",
          scope_id: "tool_d84ca194052d72d603485742598726c3",
          configuration: {
            globalTool: 50,
            workspaceTotal: 20,
            workspaceTool: 5,
          },
        },
        {
          id: "7200200500000005",
          scope_type: "tool",
          scope_id: "tool_0cd15820ee05ddd83c2734d174f01d7b",
          configuration: {
            globalTool: 50,
            workspaceTotal: 20,
            workspaceTool: 5,
          },
        },
        {
          id: "7200200500000006",
          scope_type: "tool",
          scope_id: "tool_9c347a9a7f4202d9ec92941ca4532809",
          configuration: {
            globalTool: 50,
            workspaceTotal: 20,
            workspaceTool: 5,
          },
        },
      ]);

      const grants = await client.query(
        "select id from relay.entitlement_grants where source_reference = $1",
        [MVP_ENTITLEMENT_SOURCE],
      );
      assertEquals(
        grants.rows,
        [],
        "the baseline must not grant automatic unlimited usage",
      );

      const privileges = await client.query<{
        account_delete: boolean;
        reservation_delete: boolean;
        idempotency_insert: boolean;
        idempotency_update: boolean;
        idempotency_delete: boolean;
      }>(
        `select
           has_table_privilege(current_user, 'relay.artifact_storage_accounts', 'DELETE') as account_delete,
           has_table_privilege(current_user, 'relay.artifact_storage_reservations', 'DELETE') as reservation_delete,
           has_table_privilege(current_user, 'relay.artifact_mutation_idempotency', 'INSERT') as idempotency_insert,
           has_table_privilege(current_user, 'relay.artifact_mutation_idempotency', 'UPDATE') as idempotency_update,
           has_table_privilege(current_user, 'relay.artifact_mutation_idempotency', 'DELETE') as idempotency_delete`,
      );
      assertEquals(privileges.rows[0], {
        account_delete: false,
        reservation_delete: false,
        idempotency_insert: true,
        idempotency_update: false,
        idempotency_delete: false,
      });
    } finally {
      await client.end();
    }
  },
});
