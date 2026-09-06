import { assert, assertEquals } from "@std/assert";
import { createPostgresAdmissionUsagePort } from "@relay/application";
import { ArtifactService, PostgresArtifactQuota } from "@relay/artifacts";
import type { RuntimeConfig } from "@relay/config";
import { createDatabasePool } from "@relay/database";
import {
  createAzureFlux2ProClient,
  createAzureGptImage2Client,
  createAzureMistralOcrClient,
} from "@relay/providers";
import { admitToolRun } from "@relay/queue";
import { createS3ObjectStorage, sha256Hex } from "@relay/storage";
import { Redis } from "ioredis";
import pg from "pg";
import {
  asFetch,
  base64,
  jsonResponse,
  pngBytes,
  requestBody,
  TEST_API_KEY,
} from "../../../packages/providers/src/test_helpers.ts";
import { createMvpExecutionHandlers } from "./mvp-handlers.ts";
import { createExecutionHandlerRegistry, startWorker } from "./worker.ts";

const databaseUrl = Deno.env.get("DATABASE_URL");
const redisUrl = Deno.env.get("REDIS_URL");
const ownerUrl = Deno.env.get("AUTH_SECURITY_TEST_DATABASE_URL");
const enabled = Deno.env.get("RUN_ARTIFACT_CONTRACT_TESTS") === "1" &&
  databaseUrl !== undefined && redisUrl !== undefined && ownerUrl !== undefined;

/** Real admission, capacity, queue, handlers, metering and MinIO; only Azure is stubbed. */
Deno.test({
  name:
    "MVP tools require explicit allowances and persist metered outputs through the worker",
  ignore: !enabled,
  fn: async () => {
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const environment = `mvp-pipeline-${suffix}`;
    const workspaceId = `mvp-workspace-${suffix}`;
    const userId = `mvp-user-${suffix}`;
    const config: RuntimeConfig = {
      appName: "Relay pipeline test",
      deploymentEnvironment: environment,
      port: 8000,
      build: { version: "test", revision: "test" },
      database: {
        url: new URL(databaseUrl!),
        poolMax: 8,
        connectTimeoutMs: 5_000,
        statementTimeoutMs: 30_000,
      },
      redis: { url: new URL(redisUrl!), connectTimeoutMs: 5_000 },
    };
    const pool = createDatabasePool(config.database, "relay-worker");
    const owner = new pg.Client({ connectionString: ownerUrl! });
    const redis = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const storage = createS3ObjectStorage({
      bucket: "relay-artifacts",
      region: "us-east-1",
      internalEndpoint: Deno.env.get("MINIO_ENDPOINT") ??
        "http://127.0.0.1:9000",
      credentials: {
        accessKeyId: Deno.env.get("MINIO_ACCESS_KEY") ?? "relay_dev_only",
        secretAccessKey: Deno.env.get("MINIO_SECRET_KEY") ?? "relay_dev_only",
      },
      forcePathStyle: true,
      bucketVersioning: "enabled",
    });
    const artifacts = new ArtifactService({
      pool,
      storage,
      quota: new PostgresArtifactQuota({
        limitProvider: {
          getLimit: () =>
            Promise.resolve({ kind: "limited", maxBytes: "1048576" }),
        },
      }),
    });
    const imageBytes = pngBytes(1024, 1024);
    let providerCalls = 0;
    let annotation: string | null = null;
    const options = { apiKey: TEST_API_KEY };
    const registry = createExecutionHandlerRegistry(createMvpExecutionHandlers({
      pool,
      storage,
      artifactService: artifacts,
      gptImage2Client: createAzureGptImage2Client({
        ...options,
        fetch: asFetch((_url, init) => {
          providerCalls++;
          assertEquals((requestBody(init) as { n: number }).n, 2);
          return jsonResponse({
            data: [
              { b64_json: base64(imageBytes) },
              { b64_json: base64(imageBytes) },
            ],
          });
        }),
      }),
      flux2ProClient: createAzureFlux2ProClient({
        ...options,
        fetch: asFetch((_url, init) => {
          providerCalls++;
          assertEquals(
            (requestBody(init) as { input_image: string }).input_image,
            `data:image/png;base64,${base64(imageBytes)}`,
          );
          return jsonResponse({ data: [{ b64_json: base64(imageBytes) }] });
        }),
      }),
      mistralOcrClient: createAzureMistralOcrClient({
        ...options,
        fetch: asFetch((_url, init) => {
          providerCalls++;
          assertEquals((requestBody(init) as { document: unknown }).document, {
            type: "image_url",
            image_url: `data:image/png;base64,${base64(imageBytes)}`,
          });
          return jsonResponse({
            pages: [{
              index: 0,
              markdown: "",
              images: [],
              tables: [],
              dimensions: null,
            }],
            model: "mistral-ocr-4-0",
            document_annotation: annotation,
            usage_info: { pages_processed: 1, doc_size_bytes: null },
          });
        }),
      }),
    }));
    const usage = createPostgresAdmissionUsagePort();
    const abort = new AbortController();
    const logs: unknown[] = [];
    let worker: Promise<void> | undefined;
    let workerError: unknown;
    try {
      await owner.connect();
      await pool.query(
        `insert into auth."user" (id, name, email, "emailVerified") values ($1, 'Pipeline test', $2, true)`,
        [userId, `${suffix}@example.test`],
      );
      await pool.query(
        `insert into auth.organization (id, name, slug, "createdAt") values ($1, 'Pipeline test', $1, now())`,
        [workspaceId],
      );
      await pool.query(
        `insert into auth.member (id, "organizationId", "userId", role, "createdAt") values ($1, $2, $3, 'owner', now())`,
        [`member-${suffix}`, workspaceId, userId],
      );
      const tools = await pool.query<
        { key: string; active_version_id: string }
      >(
        `select key, active_version_id from relay.tools where key = any($1)`,
        [[
          "image.generate.gpt-image-2",
          "image.generate.flux-2-pro",
          "document.ocr",
        ]],
      );
      assertEquals(tools.rows.length, 3);
      const versions = new Map<string, string>(
        tools.rows.map((
          row: { key: string; active_version_id: string },
        ) => [row.key, row.active_version_id]),
      );
      const admit = (
        key: string,
        input: unknown,
        idempotencyKey = crypto.randomUUID(),
      ) => {
        return admitToolRun(pool, {
          workspaceId,
          createdBy: userId,
          toolVersionId: versions.get(key)!,
          input,
          idempotencyKey,
          admissionDeadlineMs: 60_000,
          runDeadlineMs: 120_000,
        }, { handlers: registry.catalogHandlers, usage });
      };
      const imageInput = { prompt: "pipeline-prompt-canary", n: 2 };
      assertEquals(
        (await admit("image.generate.gpt-image-2", imageInput)).kind,
        "not_entitled",
      );
      assertEquals(providerCalls, 0);

      await owner.query("begin");
      await owner.query("set local role relay_owner");
      await owner.query(
        `insert into relay.entitlement_grants
           (id, workspace_id, entitlement_key, grant_kind, capability_enabled, source_kind, source_reference, effective_at)
         values ($1, $2, 'tools.execute', 'capability', true, 'manual', 'mvp-pipeline-test', now() - interval '1 second')`,
        [`grant-cap-${suffix}`, workspaceId],
      );
      await owner.query("commit");
      assertEquals(
        (await admit("image.generate.gpt-image-2", imageInput)).kind,
        "not_entitled",
      );
      await owner.query("begin");
      await owner.query("set local role relay_owner");
      for (
        const [metric, unit] of [["images.generated", "image"], [
          "ocr.requests",
          "request",
        ]]
      ) {
        await owner.query(
          `insert into relay.entitlement_grants
             (id, workspace_id, entitlement_key, grant_kind, limit_amount, unit, period, source_kind, source_reference, effective_at)
           values ($1, $2, $3, 'limit', 3, $4, 'calendar_month', 'manual', 'mvp-pipeline-test', now() - interval '1 second')`,
          [`grant-${metric}-${suffix}`, workspaceId, metric, unit],
        );
      }
      await owner.query("commit");
      worker = startWorker(config, {
        pool,
        handlerRegistry: registry,
        signal: abort.signal,
        installSignalHandlers: false,
        environment,
        queuePrefix: `relay:${environment}:bullmq`,
        relayPollIntervalMs: 20,
        schedulerPollIntervalMs: 10,
        maintenanceIntervalMs: 1_000,
        reconciliationLockMs: 500,
        redisResetCooldownMs: 0,
        shutdownDeadlineMs: 10_000,
        log: (record) => logs.push(record),
      }).catch((error) => {
        workerError = error;
      });

      const execute = async (
        key: string,
        input: unknown,
        count: number,
        outcome = "success",
      ) => {
        const idempotencyKey = crypto.randomUUID();
        const admitted = await admit(key, input, idempotencyKey);
        assert(admitted.kind === "admitted", JSON.stringify(admitted));
        const deadline = Date.now() + 15_000;
        let status = "queued";
        while (Date.now() < deadline) {
          if (workerError !== undefined) throw workerError;
          const state = await pool.query<{ status: string }>(
            "select status from relay.tool_runs where id = $1",
            [admitted.runId],
          );
          status = state.rows[0].status;
          if (["succeeded", "failed", "cancelled"].includes(status)) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assertEquals(status, "succeeded", JSON.stringify(logs));
        const items = await pool.query<{
          name: string;
          status: string;
          error_code: string | null;
          artifact_version_id: string | null;
          object_key: string | null;
          storage_version_id: string | null;
          sha256: string | null;
        }>(
          `select i.name, i.status, i.error_code, i.artifact_version_id, v.object_key, v.storage_version_id, v.sha256
             from relay.output_sets s join relay.output_items i on i.output_set_id = s.id
             left join relay.artifact_versions v on v.id = i.artifact_version_id
            where s.run_id = $1 order by i.ordinal`,
          [admitted.runId],
        );
        assertEquals(items.rows.length, count);
        for (const item of items.rows) {
          if (item.status === "failed") {
            assertEquals(item.name, "extraction.json");
            assertEquals(item.error_code, "provider.invalid_structured_output");
            assertEquals(item.artifact_version_id, null);
            continue;
          }
          assertEquals(item.status, "succeeded");
          assert(item.object_key !== null && item.storage_version_id !== null);
          const read = await storage.getObjectStream({
            key: item.object_key,
            storageVersionId: item.storage_version_id,
          });
          assert(read !== null);
          const bytes = new Uint8Array(
            await new Response(read.body).arrayBuffer(),
          );
          assertEquals(await sha256Hex(bytes), item.sha256);
          if (item.name === "ocr.md") assertEquals(bytes.byteLength, 0);
          if (item.name === "extraction.json") {
            assertEquals(JSON.parse(new TextDecoder().decode(bytes)), {
              total: 12,
            });
          }
        }
        const settlement = await pool.query<
          { outcome: string; status: string }
        >(
          `select e.outcome, r.status from relay.tool_runs t
             join relay.usage_reservations r on r.id = t.reservation_id
             join relay.usage_events e on e.reservation_id = r.id where t.id = $1`,
          [admitted.runId],
        );
        assertEquals(settlement.rows, [{ outcome, status: "committed" }]);
        const calls = providerCalls;
        assertEquals(
          (await admit(key, input, idempotencyKey)).kind,
          "replayed",
        );
        assertEquals(providerCalls, calls);
        return items.rows;
      };
      const generated = await execute(
        "image.generate.gpt-image-2",
        imageInput,
        2,
      );
      const sourceArtifactVersionId = generated[0].artifact_version_id!;
      await execute("image.generate.flux-2-pro", {
        prompt: "pipeline-prompt-canary",
        outputFormat: "png",
        inputArtifactVersionIds: [sourceArtifactVersionId],
      }, 1);
      assertEquals(
        (await admit("image.generate.gpt-image-2", imageInput)).kind,
        "allowance_exceeded",
      );
      await execute("document.ocr", { sourceArtifactVersionId }, 2);
      const extractionSchema = {
        type: "object",
        properties: { total: { type: "number" } },
        required: ["total"],
        additionalProperties: false,
      };
      annotation = '{"total":12}';
      await execute("document.ocr", {
        sourceArtifactVersionId,
        extractionSchema,
      }, 3);
      annotation = '{"total":"invalid"}';
      await execute(
        "document.ocr",
        { sourceArtifactVersionId, extractionSchema },
        3,
        "partial_output",
      );
      assertEquals(
        (await admit("document.ocr", { sourceArtifactVersionId })).kind,
        "allowance_exceeded",
      );
      assertEquals(providerCalls, 5);
      const quantities = await pool.query<
        { metric_key: string; quantity: string }
      >(
        `select metric_key, sum(quantity)::text as quantity from relay.usage_events where workspace_id = $1 group by metric_key order by metric_key`,
        [workspaceId],
      );
      assertEquals(
        quantities.rows.map((
          row: { metric_key: string; quantity: string },
        ) => [row.metric_key, Number(row.quantity)]),
        [["images.generated", 3], ["ocr.requests", 3]],
      );
      // No production price is configured; a successful run must not invent one.
      const costs = await pool.query(
        "select id from relay.provider_cost_events where workspace_id = $1",
        [workspaceId],
      );
      assertEquals(costs.rowCount, 0);
      for (
        const secret of [
          TEST_API_KEY,
          "pipeline-prompt-canary",
          base64(imageBytes),
        ]
      ) {
        assertEquals(JSON.stringify(logs).includes(secret), false);
      }
    } finally {
      abort.abort();
      await worker;
      const keys = await redis.keys(`relay:${environment}:*`);
      if (keys.length > 0) await redis.del(...keys);
      await redis.quit();
      const objects = await pool.query<{ object_key: string }>(
        "select object_key from relay.artifact_versions where workspace_id = $1",
        [workspaceId],
      );
      for (const object of objects.rows) {
        await storage.hardDeleteObject({ key: object.object_key });
      }
      storage.close();
      await owner.end();
      // Append-only run, grant and usage audit rows remain in the disposable test DB.
      await pool.end();
    }
    if (workerError !== undefined) throw workerError;
  },
});
