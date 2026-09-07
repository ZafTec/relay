import { sql } from "kysely";
import type { Migration } from "./types.ts";

export const CANONICAL_SQL = `
INSERT INTO relay.providers (id, key, name, lifecycle, configuration_reference)
OVERRIDING SYSTEM VALUE VALUES
 (7200200100000004, 'azure-mai-image-2.5', 'Azure MAI Image 2.5', 'published', 'azure-mai-image-2.5'),
 (7200200100000005, 'azure-mai-image-2.5-flash', 'Azure MAI Image 2.5 Flash', 'published', 'azure-mai-image-2.5-flash');
INSERT INTO relay.provider_models (id, provider_id, key, display_name, capability_schema, lifecycle)
OVERRIDING SYSTEM VALUE VALUES
 (7200200200000004, 7200200100000004, 'MAI-Image-2.5', 'MAI Image 2.5', '{"generation":true,"editing":true,"outputFormat":"png"}', 'published'),
 (7200200200000005, 7200200100000005, 'MAI-Image-2.5-Flash', 'MAI Image 2.5 Flash', '{"generation":true,"editing":true,"outputFormat":"png"}', 'published');
INSERT INTO relay.capacity_pools (id, key, provider_model_id, execution_class, enabled)
OVERRIDING SYSTEM VALUE VALUES
 (7200200300000004, 'azure-mai-image-2.5', 7200200200000004, 'standard', true),
 (7200200300000005, 'azure-mai-image-2.5-flash', 7200200200000005, 'standard', true);
INSERT INTO relay.capacity_policies (scope_type, scope_id, revision, configuration, effective_at)
VALUES
 ('capacity_pool', '7200200300000004', 1, '{"submissionRateDefaults":{"providerPerMinute":2},"executionConcurrency":{"globalTool":1,"pool":1,"workspaceTotal":1,"workspaceTool":1}}', now()),
 ('capacity_pool', '7200200300000005', 1, '{"submissionRateDefaults":{"providerPerMinute":2},"executionConcurrency":{"globalTool":1,"pool":1,"workspaceTotal":1,"workspaceTool":1}}', now());

DO $body$
DECLARE
  spec record;
  template relay.tool_versions%ROWTYPE;
  tool_id text;
  version_id text;
  input_schema jsonb;
  output_schema jsonb;
  compatibility jsonb;
  published_at timestamptz := now();
BEGIN
  FOR spec IN SELECT * FROM (VALUES
    ('image.edit.gpt-image-2', 'GPT Image 2 · Edit', 'Edit images with references and an optional PNG mask.', 'image.edit.azure-openai.gpt-image-2.v1', 'tver_11916cf469e30a49a4becb0ca4b994a5', 7200200200000001::bigint, 7200200300000001::bigint, 'gpt'),
    ('image.edit.flux-2-pro', 'FLUX.2 Pro · Edit', 'Edit images using up to eight reference images.', 'image.edit.azure-flux.flux-2-pro.v1', 'tver_d1136a97173f7ba1f2bf117a86dfa98e', 7200200200000002, 7200200300000002, 'flux'),
    ('image.generate.mai-image-2.5', 'MAI Image 2.5', 'Generate a PNG image from a text prompt.', 'image.generate.azure-mai.mai-image-2.5.v1', 'tver_d1136a97173f7ba1f2bf117a86dfa98e', 7200200200000004, 7200200300000004, 'mai-generate'),
    ('image.edit.mai-image-2.5', 'MAI Image 2.5 · Edit', 'Edit a JPEG or PNG image with a text instruction.', 'image.edit.azure-mai.mai-image-2.5.v1', 'tver_d1136a97173f7ba1f2bf117a86dfa98e', 7200200200000004, 7200200300000004, 'mai-edit'),
    ('image.generate.mai-image-2.5-flash', 'MAI Image 2.5 Flash', 'Generate a PNG image with MAI Image 2.5 Flash.', 'image.generate.azure-mai.mai-image-2.5-flash.v1', 'tver_d1136a97173f7ba1f2bf117a86dfa98e', 7200200200000005, 7200200300000005, 'mai-generate'),
    ('image.edit.mai-image-2.5-flash', 'MAI Image 2.5 Flash · Edit', 'Edit a JPEG or PNG image with MAI Image 2.5 Flash.', 'image.edit.azure-mai.mai-image-2.5-flash.v1', 'tver_d1136a97173f7ba1f2bf117a86dfa98e', 7200200200000005, 7200200300000005, 'mai-edit')
  ) AS items(key, name, summary, handler, template_id, model_id, pool_id, operation)
  LOOP
    SELECT * INTO STRICT template FROM relay.tool_versions WHERE id = spec.template_id;
    tool_id := 'tool_' || md5(spec.key);
    version_id := 'tver_' || md5(spec.key || ':1');
    input_schema := template.input_schema;
    output_schema := template.output_schema;
    IF spec.operation = 'gpt' THEN
      input_schema := jsonb_set(input_schema, '{required}', '["prompt","inputArtifactVersionIds"]');
      input_schema := jsonb_set(input_schema, '{properties}', (input_schema->'properties') || '{"inputArtifactVersionIds":{"type":"array","minItems":1,"maxItems":16,"uniqueItems":true,"items":{"type":"string","pattern":"^aver_[0-9a-f]{32}$"}},"maskArtifactVersionId":{"type":"string","pattern":"^aver_[0-9a-f]{32}$","description":"PNG mask with the same dimensions as the first reference image."},"inputFidelity":{"type":"string","enum":["low","high"]}}');
    ELSIF spec.operation = 'flux' THEN
      input_schema := jsonb_set(input_schema, '{required}', '["prompt","inputArtifactVersionIds"]');
    ELSE
      input_schema := '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","additionalProperties":false,"required":["prompt"],"properties":{"prompt":{"type":"string","minLength":1,"maxLength":32000}}}';
      IF spec.operation = 'mai-generate' THEN
        input_schema := jsonb_set(input_schema, '{properties}', (input_schema->'properties') || '{"width":{"type":"integer","minimum":768,"maximum":1365,"default":1024},"height":{"type":"integer","minimum":768,"maximum":1365,"default":1024}}');
        input_schema := input_schema || '{"x-relay-maximum-pixels":1048576}';
      ELSE
        input_schema := jsonb_set(input_schema, '{required}', '["prompt","sourceArtifactVersionId"]');
        input_schema := jsonb_set(input_schema, '{properties}', (input_schema->'properties') || '{"sourceArtifactVersionId":{"type":"string","pattern":"^aver_[0-9a-f]{32}$","description":"A verified JPEG or PNG artifact version in this workspace."}}');
      END IF;
      output_schema := jsonb_set(output_schema - 'seed', '{properties,artifacts,items,properties,mimeType,enum}', '["image/png"]');
      output_schema := output_schema #- '{properties,seed}';
    END IF;
    input_schema := input_schema || jsonb_build_object('$id', 'urn:relay:tool:' || spec.key || ':input:1', 'title', spec.name || ' input');
    output_schema := output_schema || jsonb_build_object('$id', 'urn:relay:tool:' || spec.key || ':output:1', 'title', spec.name || ' output');
    compatibility := jsonb_build_object('handler', jsonb_build_object('key',spec.handler,'inputSchemaVersion',1,'handlerVersion','1'), 'submission',jsonb_build_object('providerIdempotency','unsupported','operationLookup',false,'ambiguousRetry','forbidden'),'routing',jsonb_build_object('fallback','none'));
    INSERT INTO relay.tools (id,key,name,category,summary,lifecycle,visibility,readiness_critical)
    VALUES (tool_id,spec.key,spec.name,'image',spec.summary,'internal','public',false);
    INSERT INTO relay.tool_versions
      (id,tool_id,version,input_schema,output_schema,handler_key,input_schema_version,handler_version,execution_mode,max_duration_seconds,meter_policy_id,entitlement_key,compatibility_metadata,published_at,immutable_hash)
    VALUES
      (version_id,tool_id,1,input_schema,output_schema,spec.handler,1,'1','async',300,template.meter_policy_id,'tools.execute',compatibility,published_at,
       relay.compute_tool_version_immutable_hash(version_id,tool_id,1,input_schema,output_schema,spec.handler,1,'1','async',300,template.meter_policy_id,'tools.execute',compatibility));
    INSERT INTO relay.tool_provider_bindings (tool_version_id,provider_model_id,capacity_pool_id,routing_order,enabled)
    VALUES (version_id,spec.model_id,spec.pool_id,1,true);
    INSERT INTO relay.capacity_policies (scope_type,scope_id,revision,configuration,effective_at)
    VALUES ('tool',tool_id,1,'{"globalTool":50,"workspaceTotal":20,"workspaceTool":5}',published_at);
    UPDATE relay.tools SET lifecycle='published',active_version_id=version_id WHERE id=tool_id;
    INSERT INTO relay.audit_events(actor_type,action,target_type,target_id,outcome)
    VALUES ('system','tool.publish','tool',tool_id,'success');
  END LOOP;
END;
$body$;
-- Execution and metric allowances are still explicitly granted by an operator.
`;

export const migration: Migration = {
  id: "0004_image_generation_and_editing",
  checksumSha256:
    "fe561302ab2ffa0c89aa7156db2c515a21e48405c08e651bd2c782dc4aa5d499",
  transactional: true,
  up: async (db) => {
    await sql.raw(CANONICAL_SQL).execute(db);
  },
};
