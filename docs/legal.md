# Legal integration notes

Status: architecture decision with product-specific legal work pending\
Last checked against the deployed ZafTech legal pages: 2026-09-07

This document records technical integration requirements. It is not legal
advice, and the final product-specific language should receive legal review.

## Canonical documents

The company-wide documents on **zaftech.co** remain canonical, as requested by
the owner. Relay links to them from its footer, sign-in, authorization, and
workspace settings screens. It does not publish separate legal terms.

Automated public requests returned Cloudflare 403 on this review date. The
published HTML was read from the existing landing-page deployment and compared
with the local landing-page source. No website or Cloudflare settings were
changed.

| Document              | Canonical URL                       | Page metadata when verified              |
| --------------------- | ----------------------------------- | ---------------------------------------- |
| Terms of Service      | <https://zaftech.co/terms>          | Effective 2026-04-24; updated 2026-04-24 |
| Privacy Policy        | <https://zaftech.co/privacy>        | Effective 2026-04-24; updated 2026-07-17 |
| Refund Policy         | <https://zaftech.co/refunds>        | Effective 2026-04-24; updated 2026-04-24 |
| Cookie Policy         | <https://zaftech.co/cookies>        | Effective 2026-04-24; updated 2026-07-17 |
| Acceptable Use Policy | <https://zaftech.co/acceptable-use> | Effective 2026-04-24; updated 2026-04-24 |

The path `/privacy-policy` returned 404 when checked. The canonical privacy path
is `/privacy`.

Product routes such as `/legal/terms` and `/legal/privacy` should redirect to
the canonical pages rather than copying their HTML. This prevents product copies
from becoming stale.

OAuth client metadata should use the externally configured canonical URLs.
Example metadata:

```text
tos: https://zaftech.co/terms
policy: https://zaftech.co/privacy
```

## Existing coverage

The current documents already provide a company-wide baseline for:

- Current and future ZafTech SaaS products
- Account registration and account responsibility
- Subscriptions, Paddle billing, renewals, cancellation, and refunds
- Ownership and processing of user-generated content
- Service availability, termination, disclaimers, and liability
- General data retention and deletion
- Consent-based analytics and cookies
- Prohibited content, abuse, malware, unauthorized access, and service
  degradation

## Relay behavior

The source code and distributed binaries use the MIT license. MIT governs the
software distribution; ZafTech's canonical policies govern use of its hosted
service. Third-party licenses remain intact.

Optional browser performance/error telemetry starts only after an explicit
analytics choice. Relay uses the Cookie Policy's `zaf_consent` and
`zaf_consent_at` keys with a 180-day lifetime on its own origin. Cookie settings
can be reopened from the public footer or workspace settings. Withdrawal stops
delivery and queued telemetry is rechecked before sending. There are no Google
Analytics or advertising integrations in Relay.

Run notification email is separately opt-in per user/workspace. Generated files
and uploads are private by default. Permanent access URLs require an explicit
share and remain revocable.

## Product-specific additions required

Before launch, the legal documents or a linked product addendum should address:

- Uploaded files, generated images, and file-version history
- Private files versus explicitly shared download links
- Expiring links, link revocation, and user responsibility for recipients
- Storage, egress, generation, job, and version-retention limits
- Data retention after cancellation, workspace deletion, or failed payment
- Soft deletion, purge timing, backups, and legal holds
- Temporary processing copies and failed-job artifacts
- User responsibility for rights to uploaded and generated content
- Malicious-file handling, abuse scanning, suspension, and removal
- Image prompts and files sent to external generation providers
- Whether providers retain prompts, inputs, or generated outputs
- AI output limitations, provider availability, and non-determinism
- Export and deletion behavior
- Additional infrastructure, OAuth, image-provider, email, and observability
  subprocessors
- Product-specific refund treatment, including consumed usage

The Refund Policy currently has per-product sections but does not include this
product.

## Accuracy updates required during implementation

The Privacy Policy currently mentions password data. This product is planned to
use Google and GitHub OAuth only, so its product-specific disclosure should
describe OAuth identities, account identifiers, and provider tokens accurately.

The Cookie Policy currently lists generic `session` and `csrf` names and a
30-day login period. Before launch, align it with the actual Better Auth cookie
names, cookie attributes, and configured session lifetime.

MinIO itself is not an external processor when self-hosted. The VPS or hosting
provider operating the underlying infrastructure may be a processor and should
be disclosed accurately.

The application must not claim that uploaded data is encrypted at rest unless
this is verified for PostgreSQL, object storage, backups, and infrastructure
volumes.

## Legal document version records

The application should track the legal version accepted by a user rather than
only recording a boolean:

```text
legal_documents
  document_type
  version
  effective_at
  canonical_url
  content_sha256
  requires_acceptance

legal_acceptances
  user_id
  workspace_id nullable
  document_type
  version
  accepted_at
  ip_address
  user_agent
```

The current document can be represented by a version string or effective date
and a content hash captured from the approved source. A hash provides evidence
of the exact content presented even if the canonical page changes later.

For an MCP authorization flow, the OAuth Provider post-login stage should:

1. Ensure the user has selected a workspace.
2. Determine whether required legal versions have been accepted.
3. Redirect to product onboarding or legal acceptance when necessary.
4. Continue to the OAuth consent screen after acceptance.
