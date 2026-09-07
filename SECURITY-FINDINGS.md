# Security findings

Findings from security reviews, kept here so they persist outside any one session.

## 2026-09-04 — automated commit review: cap-defeat / plaintext-credentials in `packages/config/src/index.ts`

**Source:** automated background security review triggered on commit `aa7ef75`
("Add storage, artifact, share-token, and provider configuration").

**Summary reported:** possible capability-check defeat and plaintext credential
handling in the new S3/artifact/share-token/Azure config loaders.

**Investigation:** read the full diff and the resulting loader functions
(`loadS3Config`, `loadArtifactLifecycleConfig`, `loadShareTokenKeyringConfig`,
`loadAzureProviderConfig`) plus every place that could plausibly log or
serialize them (`apps/api/src/server.ts`, worker/healthcheck entry points, and
a repo-wide grep for `console.*`/`JSON.stringify` near any `*Config` value).
Found no logging, telemetry, or audit-event call that serializes these config
objects; `packages/observability`'s redaction layer is unaffected because
nothing routes through it. All numeric bounds (`S3_REQUEST_TIMEOUT_MS`,
`AZURE_*_BYTES`, artifact TTLs, etc.) are validated with explicit min/max
ranges and reject non-finite/out-of-range input; the S3/public endpoint
readers reject embedded credentials, query strings, and non-HTTPS in
production.

**Conclusion:** no exploitable exposure path was found. `S3_SECRET_ACCESS_KEY`
and the Azure resource API keys are held as plain in-memory strings, and
`SHARE_TOKEN_KEYS` secrets are decoded to a plain `Uint8Array` — this is
necessary to actually sign requests/calls and is not evidence of a defeat on
its own. This most likely reflects a heuristic scanner flagging the presence
of fields named `secretAccessKey`/`apiKey`/`secret` rather than a
demonstrated leak.

**Follow-up (not urgent, not yet done):** consider wrapping these fields in a
small redacting type (custom `toString`/`toJSON` that returns a placeholder)
so an accidental future `console.log(config)` or exception with the config
object attached can't print the raw value. Low priority since no such call
site exists today.
