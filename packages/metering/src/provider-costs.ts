import { fingerprint, generateMeteringId, sha256Hex } from "./canonical.ts";
import { normalizeDecimalAmount } from "./decimal.ts";
import { transactionTimestamp } from "./entitlements.ts";
import {
  calculateProviderCost,
  InvalidPolicyError,
  parsePricingPolicyDocument,
  type PricingPolicyDocumentV1,
  type ProviderCostCalculation,
} from "./policies.ts";
import { lockIdempotencyKey } from "./postgres.ts";
import {
  assertMeteringTransaction,
  type MeteringTransaction,
} from "./transaction.ts";
import type { PolicyRevisionSnapshot } from "./types.ts";
import { requireText } from "./validation.ts";

export interface RecordProviderCostInput {
  readonly workspaceId: string;
  readonly runId: string;
  readonly attemptId: string | null;
  readonly actualModelVersion: string | null;
  readonly normalizedUsage: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
}

export interface ProviderCostReceipt {
  readonly providerCostEventId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly attemptId: string | null;
  readonly providerModelId: string;
  readonly actualModelVersion: string | null;
  readonly pricingPolicy: PolicyRevisionSnapshot<PricingPolicyDocumentV1>;
  readonly calculation: ProviderCostCalculation;
  readonly occurredAt: Date;
}

export type RecordProviderCostResult =
  | {
    readonly kind: "recorded" | "replayed";
    readonly receipt: ProviderCostReceipt;
  }
  | { readonly kind: "not_found" }
  | { readonly kind: "pricing_not_configured" }
  | { readonly kind: "invalid_configuration" }
  | { readonly kind: "idempotency_conflict" };

interface CostContextRow {
  provider_model_id: string;
  pricing_policy_id: string | null;
}

interface PricingPolicyRow {
  id: string;
  policy_key: string;
  revision: number;
  document: unknown;
  immutable_hash: string;
  hash_is_valid: boolean;
}

interface ProviderCostEventRow {
  id: string;
  workspace_id: string;
  run_id: string;
  attempt_id: string | null;
  provider_model_id: string;
  actual_model_version: string | null;
  normalized_usage: Readonly<Record<string, unknown>>;
  cost_components: ProviderCostCalculation["components"];
  cost_amount: string;
  currency: string;
  pricing_policy_id: string;
  pricing_policy_key: string;
  pricing_policy_revision: number;
  pricing_policy_hash: string;
  pricing_policy_snapshot: unknown;
  request_hash: string;
  occurred_at: Date;
}

function requireBigintText(value: string, field: string): void {
  requireText(value, field);
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new TypeError(`${field} must be a positive PostgreSQL bigint string`);
  }
}

function validateInput(input: RecordProviderCostInput): void {
  requireText(input.workspaceId, "workspaceId");
  requireText(input.runId, "runId");
  if (input.attemptId !== null) requireBigintText(input.attemptId, "attemptId");
  if (input.actualModelVersion !== null) {
    requireText(input.actualModelVersion, "actualModelVersion");
  }
  requireText(input.idempotencyKey, "idempotencyKey");
  if (
    input.normalizedUsage === null ||
    typeof input.normalizedUsage !== "object" ||
    Array.isArray(input.normalizedUsage)
  ) throw new TypeError("normalizedUsage must be an object");
}

function receipt(row: ProviderCostEventRow): ProviderCostReceipt {
  const document = parsePricingPolicyDocument(row.pricing_policy_snapshot);
  return {
    providerCostEventId: row.id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    attemptId: row.attempt_id === null ? null : String(row.attempt_id),
    providerModelId: String(row.provider_model_id),
    actualModelVersion: row.actual_model_version,
    pricingPolicy: {
      id: row.pricing_policy_id,
      key: row.pricing_policy_key,
      revision: row.pricing_policy_revision,
      immutableHash: row.pricing_policy_hash,
      document,
    },
    calculation: {
      currency: row.currency,
      amount: normalizeDecimalAmount(row.cost_amount),
      components: row.cost_components,
    },
    occurredAt: row.occurred_at,
  };
}

const COST_EVENT_COLUMNS = `
  id, workspace_id, run_id, attempt_id::text, provider_model_id::text,
  actual_model_version, normalized_usage, cost_components, cost_amount,
  currency, pricing_policy_id, pricing_policy_key, pricing_policy_revision,
  pricing_policy_hash, pricing_policy_snapshot, request_hash, occurred_at
`;

export async function recordProviderCostEvent(
  transaction: MeteringTransaction,
  input: RecordProviderCostInput,
): Promise<RecordProviderCostResult> {
  assertMeteringTransaction(transaction);
  validateInput(input);
  const keyHash = await sha256Hex(input.idempotencyKey);
  await lockIdempotencyKey(
    transaction,
    input.workspaceId,
    "provider-cost",
    keyHash,
  );

  // The run/workspace/attempt predicate is deliberately one non-disclosing
  // existence check: a mismatched workspace looks exactly like an unknown run.
  const context = await transaction.query<CostContextRow>(
    `select decision.provider_model_id::text, model.pricing_policy_id
       from relay.tool_runs run
       join relay.routing_decisions decision on decision.tool_run_id = run.id
       join relay.provider_models model on model.id = decision.provider_model_id
      where run.id = $1 and run.workspace_id = $2
        and (
          $3::bigint is null
          or exists (
            select 1
              from relay.job_attempts attempt
              join relay.execution_jobs job on job.id = attempt.job_id
             where attempt.id = $3::bigint
               and job.run_id = run.id
               and attempt.routing_decision_id = decision.id
          )
        )`,
    [input.runId, input.workspaceId, input.attemptId],
  );
  if (context.rows.length === 0) return { kind: "not_found" };
  const providerModelId = context.rows[0].provider_model_id;
  const requestHash = await fingerprint({
    operation: "record-provider-cost",
    workspaceId: input.workspaceId,
    runId: input.runId,
    attemptId: input.attemptId,
    providerModelId,
    actualModelVersion: input.actualModelVersion,
    normalizedUsage: input.normalizedUsage,
  });

  const existing = await transaction.query<ProviderCostEventRow>(
    `select ${COST_EVENT_COLUMNS}
       from relay.provider_cost_events
      where workspace_id = $1 and idempotency_key_hash = $2`,
    [input.workspaceId, keyHash],
  );
  if (existing.rows.length > 0) {
    if (existing.rows[0].request_hash !== requestHash) {
      return { kind: "idempotency_conflict" };
    }
    return { kind: "replayed", receipt: receipt(existing.rows[0]) };
  }

  const pricingPolicyId = context.rows[0].pricing_policy_id;
  if (pricingPolicyId === null) return { kind: "pricing_not_configured" };
  const at = await transactionTimestamp(transaction);
  const policyRows = await transaction.query<PricingPolicyRow>(
    `select id, policy_key, revision, document, immutable_hash,
            immutable_hash = relay.compute_pricing_policy_immutable_hash(
              id, policy_key, revision, document, effective_at, expires_at
            ) as hash_is_valid
       from relay.pricing_policies
      where id = $1
        and effective_at <= $2
        and (expires_at is null or expires_at > $2)`,
    [pricingPolicyId, at],
  );
  if (policyRows.rows.length === 0) {
    return { kind: "pricing_not_configured" };
  }
  if (!policyRows.rows[0].hash_is_valid) {
    return { kind: "invalid_configuration" };
  }

  let policy: PricingPolicyDocumentV1;
  let calculation: ProviderCostCalculation;
  try {
    policy = parsePricingPolicyDocument(policyRows.rows[0].document);
    calculation = calculateProviderCost(policy, input.normalizedUsage);
  } catch (error) {
    if (error instanceof InvalidPolicyError) {
      return { kind: "invalid_configuration" };
    }
    throw error;
  }

  const eventId = generateMeteringId("provider_cost");
  const inserted = await transaction.query<ProviderCostEventRow>(
    `insert into relay.provider_cost_events (
       id, workspace_id, run_id, attempt_id, provider_model_id,
       actual_model_version, normalized_usage, cost_components, cost_amount,
       currency, pricing_policy_id, pricing_policy_key,
       pricing_policy_revision, pricing_policy_hash, pricing_policy_snapshot,
       idempotency_key_hash, request_hash, occurred_at
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9,
       $10, $11, $12, $13, $14, $15, $16, $17, $18
     )
     returning ${COST_EVENT_COLUMNS}`,
    [
      eventId,
      input.workspaceId,
      input.runId,
      input.attemptId,
      providerModelId,
      input.actualModelVersion,
      JSON.stringify(input.normalizedUsage),
      JSON.stringify(calculation.components),
      calculation.amount,
      calculation.currency,
      policyRows.rows[0].id,
      policyRows.rows[0].policy_key,
      policyRows.rows[0].revision,
      policyRows.rows[0].immutable_hash,
      JSON.stringify(policyRows.rows[0].document),
      keyHash,
      requestHash,
      at,
    ],
  );
  return { kind: "recorded", receipt: receipt(inserted.rows[0]) };
}
