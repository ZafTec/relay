import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import pg from "pg";
import { CANONICAL_SQL, migration } from "./0027_catalog_integrity.ts";
import { sha256Hex } from "./checksum.ts";

Deno.test("0027_catalog_integrity checksum matches its canonical SQL", async () => {
  assertEquals(await sha256Hex(CANONICAL_SQL), migration.checksumSha256);
});

Deno.test("0027 hashes every tool-version identity and contract field", () => {
  for (
    const field of [
      "'id', p_id",
      "'tool_id', p_tool_id",
      "'version', p_version",
      "'input_schema', p_input_schema",
      "'output_schema', p_output_schema",
      "'handler_key', p_handler_key",
      "'input_schema_version', p_input_schema_version",
      "'handler_version', p_handler_version",
      "'execution_mode', p_execution_mode",
      "'max_duration_seconds', p_max_duration_seconds",
      "'meter_policy_id', p_meter_policy_id",
      "'entitlement_key', p_entitlement_key",
      "'compatibility_metadata', p_compatibility_metadata",
    ]
  ) {
    assertStringIncludes(CANONICAL_SQL, field);
  }
  assertStringIncludes(CANONICAL_SQL, "tool_versions_contract_hash_valid");
});

Deno.test("0027 installs immutable route snapshots and policy hashing", () => {
  for (
    const invariant of [
      "compute_routing_policy_immutable_hash",
      "routing_policies_canonical_hash",
      "tool_provider_bindings_tool_version_routing_order_key",
      "tool_provider_bindings_structure_immutable",
      "tools_active_version_belongs_to_tool_fkey",
      "routing_decisions_binding_snapshot_fkey",
      "routing_decisions_provider_model_provider_fkey",
      "routing_decisions_policy_revision_fkey",
      "routing_decisions_consistent",
      "routing_policies_immutable",
      "routing_decisions_immutable",
      "is published and fully immutable",
      "fallback is not permitted by its routing policy",
    ]
  ) {
    assertStringIncludes(CANONICAL_SQL, invariant);
  }
});

const databaseUrl = Deno.env.get("DATABASE_URL");

Deno.test({
  name: "0027 catalog integrity objects exist in PostgreSQL",
  ignore: databaseUrl === undefined,
  fn: async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const { rows: constraints } = await client.query<{ conname: string }>(
        `select conname
           from pg_constraint
          where conname in (
            'tool_versions_tool_id_id_key',
            'tools_active_version_belongs_to_tool_fkey',
            'tools_serving_lifecycle_has_active_version_check',
            'tool_provider_bindings_tool_version_routing_order_key',
            'tool_provider_bindings_route_snapshot_key',
            'provider_models_provider_id_id_key',
            'tool_runs_id_tool_version_id_key',
            'routing_policies_id_revision_hash_key',
            'routing_decisions_run_tool_version_fkey',
            'routing_decisions_tool_version_tool_fkey',
            'routing_decisions_binding_snapshot_fkey',
            'routing_decisions_provider_model_provider_fkey',
            'routing_decisions_capacity_pool_id_fkey',
            'routing_decisions_policy_revision_fkey',
            'routing_decisions_fallback_metadata_check'
          )
          order by conname`,
      );
      assertEquals(constraints.map((row: { conname: string }) => row.conname), [
        "provider_models_provider_id_id_key",
        "routing_decisions_binding_snapshot_fkey",
        "routing_decisions_capacity_pool_id_fkey",
        "routing_decisions_fallback_metadata_check",
        "routing_decisions_policy_revision_fkey",
        "routing_decisions_provider_model_provider_fkey",
        "routing_decisions_run_tool_version_fkey",
        "routing_decisions_tool_version_tool_fkey",
        "routing_policies_id_revision_hash_key",
        "tool_provider_bindings_route_snapshot_key",
        "tool_provider_bindings_tool_version_routing_order_key",
        "tool_runs_id_tool_version_id_key",
        "tool_versions_tool_id_id_key",
        "tools_active_version_belongs_to_tool_fkey",
        "tools_serving_lifecycle_has_active_version_check",
      ]);

      const { rows: triggers } = await client.query<{ tgname: string }>(
        `select tgname
           from pg_trigger
          where not tgisinternal
            and tgname in (
              'tool_versions_contract_hash_valid',
              'tools_active_version_consistent',
              'routing_policies_canonical_hash',
              'tool_provider_bindings_consistent',
              'tool_provider_bindings_structure_immutable',
              'capacity_pools_bindings_consistent',
              'routing_decisions_consistent',
              'routing_policies_immutable',
              'routing_decisions_immutable'
            )
          order by tgname`,
      );
      assertEquals(triggers.map((row: { tgname: string }) => row.tgname), [
        "capacity_pools_bindings_consistent",
        "routing_decisions_consistent",
        "routing_decisions_immutable",
        "routing_policies_canonical_hash",
        "routing_policies_immutable",
        "tool_provider_bindings_consistent",
        "tool_provider_bindings_structure_immutable",
        "tool_versions_contract_hash_valid",
        "tools_active_version_consistent",
      ]);

      const { rows: functions } = await client.query<{ present: boolean }>(
        `select
           to_regprocedure(
             'relay.compute_tool_version_immutable_hash(text,text,integer,jsonb,jsonb,text,integer,text,text,integer,text,text,jsonb)'
           ) is not null
           and to_regprocedure(
             'relay.compute_routing_policy_immutable_hash(bigint,integer,jsonb,timestamp with time zone)'
           ) is not null as present`,
      );
      assertEquals(functions[0].present, true);
    } finally {
      await client.end();
    }
  },
});

Deno.test({
  name: "0027 enforces immutable binding structure and complete decisions",
  ignore: databaseUrl === undefined,
  fn: async () => {
    const ownerUrl = new URL(databaseUrl!);
    ownerUrl.username = "relay_migrator";
    ownerUrl.password = "relay_dev_only";
    const client = new pg.Client({ connectionString: ownerUrl.toString() });
    await client.connect();
    await client.query("begin");
    try {
      await client.query("set local role relay_owner");
      await client.query(
        "select pg_advisory_xact_lock(hashtext('0027_catalog_integrity_test'))",
      );

      const suffix = crypto.randomUUID();
      const userId = `user_${suffix}`;
      const workspaceId = `org_${suffix}`;
      const toolId = `tool_${suffix}`;
      const otherToolId = `tool_other_${suffix}`;
      const toolVersionId = `tver_${suffix}`;

      await client.query(
        `insert into auth."user" (id, name, email, "emailVerified")
         values ($1, 'Test', $2, true)`,
        [userId, `${suffix}@example.com`],
      );
      await client.query(
        `insert into auth.organization (id, name, slug, "createdAt")
         values ($1, 'Test', $2, now())`,
        [workspaceId, `catalog-${suffix}`],
      );
      await client.query(
        `insert into relay.tools
           (id, key, name, lifecycle, visibility, readiness_critical)
         values ($1, $2, 'Test', 'internal', 'internal', true),
                ($3, $4, 'Other', 'internal', 'internal', false)`,
        [
          toolId,
          `catalog.${suffix}`,
          otherToolId,
          `catalog.other.${suffix}`,
        ],
      );
      await client.query(
        `insert into relay.tool_versions
           (id, tool_id, version, input_schema, output_schema, handler_key,
            input_schema_version, handler_version, execution_mode,
            max_duration_seconds, meter_policy_id, entitlement_key,
            compatibility_metadata, published_at, immutable_hash)
         values (
           $1, $2, 1, '{}', '{}', 'catalog.test', 2, '2026.08',
           'async', 30, 'meter.test', 'entitlement.test',
           '{"protocol":1}', now(),
           relay.compute_tool_version_immutable_hash(
             $1, $2, 1, '{}', '{}', 'catalog.test', 2, '2026.08',
             'async', 30, 'meter.test', 'entitlement.test', '{"protocol":1}'
           )
         )`,
        [toolVersionId, toolId],
      );
      await client.query(
        `update relay.tools
            set lifecycle = 'published', active_version_id = $2
          where id = $1`,
        [toolId, toolVersionId],
      );

      await client.query("savepoint expected_active_version_rejection");
      try {
        await assertRejects(
          () =>
            client.query(
              `update relay.tools
                  set lifecycle = 'published', active_version_id = $2
                where id = $1`,
              [otherToolId, toolVersionId],
            ),
          Error,
          "same tool",
        );
      } finally {
        await client.query(
          "rollback to savepoint expected_active_version_rejection",
        );
        await client.query(
          "release savepoint expected_active_version_rejection",
        );
      }
    } finally {
      await client.query("rollback");
      await client.end();
    }
  },
});

Deno.test({
  name: "0027 snapshots policy, route identity, and fallback in PostgreSQL",
  ignore: databaseUrl === undefined,
  fn: async () => {
    const ownerUrl = new URL(databaseUrl!);
    ownerUrl.username = "relay_migrator";
    ownerUrl.password = "relay_dev_only";
    const client = new pg.Client({ connectionString: ownerUrl.toString() });
    await client.connect();
    await client.query("begin");
    try {
      await client.query("set local role relay_owner");
      await client.query(
        "select pg_advisory_xact_lock(hashtext('0027_catalog_snapshot_test'))",
      );

      const suffix = crypto.randomUUID();
      const userId = `user_${suffix}`;
      const workspaceId = `org_${suffix}`;
      const toolId = `tool_${suffix}`;
      const toolVersionId = `tver_${suffix}`;
      const runId = `run_${suffix}`;
      const fallbackRunId = `run_fallback_${suffix}`;
      const mismatchRunId = `run_mismatch_${suffix}`;

      await client.query(
        `insert into auth."user" (id, name, email, "emailVerified")
         values ($1, 'Test', $2, true)`,
        [userId, `${suffix}@example.com`],
      );
      await client.query(
        `insert into auth.organization (id, name, slug, "createdAt")
         values ($1, 'Test', $2, now())`,
        [workspaceId, `catalog-snapshot-${suffix}`],
      );
      await client.query(
        `insert into relay.tools (id, key, name, lifecycle, visibility)
         values ($1, $2, 'Test', 'internal', 'internal')`,
        [toolId, `catalog.snapshot.${suffix}`],
      );
      await client.query(
        `insert into relay.tool_versions
           (id, tool_id, version, input_schema, output_schema, handler_key,
            input_schema_version, handler_version, execution_mode,
            max_duration_seconds, published_at, immutable_hash)
         values (
           $1, $2, 1, '{}', '{}', 'catalog.test', 2, '2026.08',
           'async', 30, now(),
           relay.compute_tool_version_immutable_hash(
             $1, $2, 1, '{}', '{}', 'catalog.test', 2, '2026.08',
             'async', 30, null, null, null
           )
         )`,
        [toolVersionId, toolId],
      );
      await client.query(
        `update relay.tools
            set lifecycle = 'published', active_version_id = $2
          where id = $1`,
        [toolId, toolVersionId],
      );

      const provider = await client.query<{ id: string }>(
        `insert into relay.providers (key, name, lifecycle)
         values ($1, 'Test provider', 'published') returning id`,
        [`provider.${suffix}`],
      );
      const providerId = provider.rows[0].id;
      const firstModel = await client.query<{ id: string }>(
        `insert into relay.provider_models
           (provider_id, key, display_name, lifecycle)
         values ($1, $2, 'First model', 'published') returning id`,
        [providerId, `model.first.${suffix}`],
      );
      const secondModel = await client.query<{ id: string }>(
        `insert into relay.provider_models
           (provider_id, key, display_name, lifecycle)
         values ($1, $2, 'Second model', 'published') returning id`,
        [providerId, `model.second.${suffix}`],
      );
      const thirdModel = await client.query<{ id: string }>(
        `insert into relay.provider_models
           (provider_id, key, display_name, lifecycle)
         values ($1, $2, 'Third model', 'published') returning id`,
        [providerId, `model.third.${suffix}`],
      );
      const firstPool = await client.query<{ id: string }>(
        `insert into relay.capacity_pools
           (key, provider_model_id, execution_class)
         values ($1, $2, 'standard') returning id`,
        [`pool.first.${suffix}`, firstModel.rows[0].id],
      );
      const secondPool = await client.query<{ id: string }>(
        `insert into relay.capacity_pools
           (key, provider_model_id, execution_class)
         values ($1, $2, 'standard') returning id`,
        [`pool.second.${suffix}`, secondModel.rows[0].id],
      );
      const thirdPool = await client.query<{ id: string }>(
        `insert into relay.capacity_pools
           (key, provider_model_id, execution_class)
         values ($1, $2, 'standard') returning id`,
        [`pool.third.${suffix}`, thirdModel.rows[0].id],
      );
      const policy = await client.query<{
        id: string;
        revision: number;
        immutable_hash: string;
        expected_hash: string;
      }>(
        `insert into relay.routing_policies (revision, policy, effective_at)
         select coalesce(max(revision), 0) + 1,
                '{"fallback":{"mode":"ordered"}}'::jsonb,
                now() - interval '1 second'
           from relay.routing_policies
         returning id, revision, immutable_hash,
                   relay.compute_routing_policy_immutable_hash(
                     id, revision, policy, effective_at
                   ) as expected_hash`,
      );
      assertEquals(policy.rows[0].immutable_hash, policy.rows[0].expected_hash);

      const firstBinding = await client.query<{ id: string }>(
        `insert into relay.tool_provider_bindings
           (tool_version_id, provider_model_id, capacity_pool_id,
            routing_order, routing_policy_id)
         values ($1, $2, $3, 1, $4)
         returning id`,
        [
          toolVersionId,
          firstModel.rows[0].id,
          firstPool.rows[0].id,
          policy.rows[0].id,
        ],
      );
      await client.query(
        `insert into relay.tool_runs
           (id, workspace_id, tool_version_id, status, input, created_by)
         values ($1, $2, $3, 'queued', '{}', $4),
                ($5, $2, $3, 'queued', '{}', $4),
                ($6, $2, $3, 'queued', '{}', $4)`,
        [
          runId,
          workspaceId,
          toolVersionId,
          userId,
          fallbackRunId,
          mismatchRunId,
        ],
      );

      const decision = await client.query<{
        id: string;
        tool_id: string;
        tool_version_id: string;
        capacity_pool_id: string;
        routing_order: number;
        routing_policy_id: string;
        routing_policy_revision: number;
        routing_policy_immutable_hash: string;
        fallback_used: boolean;
      }>(
        `insert into relay.routing_decisions
           (tool_run_id, selected_binding_id, provider_id, provider_model_id)
         values ($1, $2, $3, $4)
         returning id, tool_id, tool_version_id, capacity_pool_id,
                   routing_order, routing_policy_id, routing_policy_revision,
                   routing_policy_immutable_hash, fallback_used`,
        [runId, firstBinding.rows[0].id, providerId, firstModel.rows[0].id],
      );
      assertEquals(decision.rows[0].tool_id, toolId);
      assertEquals(decision.rows[0].tool_version_id, toolVersionId);
      assertEquals(decision.rows[0].capacity_pool_id, firstPool.rows[0].id);
      assertEquals(decision.rows[0].routing_order, 1);
      assertEquals(decision.rows[0].routing_policy_id, policy.rows[0].id);
      assertEquals(
        decision.rows[0].routing_policy_revision,
        policy.rows[0].revision,
      );
      assertEquals(
        decision.rows[0].routing_policy_immutable_hash,
        policy.rows[0].immutable_hash,
      );
      assertEquals(decision.rows[0].fallback_used, false);

      const secondBinding = await client.query<{ id: string }>(
        `insert into relay.tool_provider_bindings
           (tool_version_id, provider_model_id, capacity_pool_id,
            routing_order, routing_policy_id)
         values ($1, $2, $3, 2, $4)
         returning id`,
        [
          toolVersionId,
          secondModel.rows[0].id,
          secondPool.rows[0].id,
          policy.rows[0].id,
        ],
      );
      await client.query(
        "update relay.tool_provider_bindings set enabled = false where id = $1",
        [firstBinding.rows[0].id],
      );
      const fallback = await client.query<{
        fallback_used: boolean;
        fallback_reason: string;
      }>(
        `insert into relay.routing_decisions
           (tool_run_id, selected_binding_id, provider_id, provider_model_id)
         values ($1, $2, $3, $4)
         returning fallback_used, fallback_reason`,
        [
          fallbackRunId,
          secondBinding.rows[0].id,
          providerId,
          secondModel.rows[0].id,
        ],
      );
      assertEquals(fallback.rows[0], {
        fallback_used: true,
        fallback_reason: "higher_priority_route_unavailable",
      });

      const rejects = async (
        sqlText: string,
        params: unknown[],
        message: string,
      ) => {
        await client.query("savepoint expected_catalog_rejection");
        try {
          await assertRejects(
            () => client.query(sqlText, params),
            Error,
            message,
          );
        } finally {
          await client.query(
            "rollback to savepoint expected_catalog_rejection",
          );
          await client.query("release savepoint expected_catalog_rejection");
        }
      };

      await rejects(
        "update relay.tool_provider_bindings set routing_order = 3 where id = $1",
        [secondBinding.rows[0].id],
        "structure is immutable",
      );
      await rejects(
        "update relay.tool_versions set deprecated_at = now() where id = $1",
        [toolVersionId],
        "fully immutable",
      );
      await rejects(
        `insert into relay.routing_policies
           (revision, policy, effective_at, immutable_hash)
         values ($1, '{}', now(), repeat('0', 64))`,
        [policy.rows[0].revision + 1000000],
        "immutable_hash",
      );
      await rejects(
        "update relay.routing_policies set policy = policy where id = $1",
        [policy.rows[0].id],
        "immutable",
      );
      await rejects(
        "update relay.routing_decisions set selected_at = selected_at where id = $1",
        [decision.rows[0].id],
        "immutable",
      );
      await rejects(
        `insert into relay.tool_provider_bindings
           (tool_version_id, provider_model_id, capacity_pool_id, routing_order)
         values ($1, $2, $3, 2)`,
        [toolVersionId, thirdModel.rows[0].id, thirdPool.rows[0].id],
        "routing_order",
      );
      await rejects(
        `insert into relay.routing_decisions
           (tool_run_id, selected_binding_id, provider_id, provider_model_id,
            routing_policy_revision)
         values ($1, $2, $3, $4, $5)`,
        [
          mismatchRunId,
          secondBinding.rows[0].id,
          providerId,
          secondModel.rows[0].id,
          policy.rows[0].revision + 1,
        ],
        "policy identity",
      );
    } finally {
      await client.query("rollback");
      await client.end();
    }
  },
});
