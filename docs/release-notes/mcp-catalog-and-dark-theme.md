### Image generation works with ordinary MCP arguments

Agents can now provide the required retry key as an `idempotencyKey` argument.
Previously, Relay expected a custom metadata field that clients such as Claude
did not send, causing valid prompts to fail before a run could start. Input,
access, and allowance failures now have separate, actionable messages. Uploads,
share links, and administrative changes also accept ordinary argument keys.

### A compact tool catalog

Image models now live behind three stable tools: `relay.tools.list`,
`relay.tools.get`, and `relay.tools.execute`. Agents inspect each model's actual
schema before execution; Relay validates the input and can pin the inspected
version. Runs, files, notifications, and authorized admin tools remain available.
The documentation explains this flow and keeps long tool names readable.

**After upgrading:** refresh or reconnect Relay in Claude to reload its tools.
Integrations that call model names directly must switch to `relay.tools.execute`
with `toolKey`, `input`, and a unique `idempotencyKey`. Reuse the same key and input
when retrying an operation. Existing file/admin metadata keys remain supported.

### A calmer dark theme

Dashboard and admin backgrounds use deep charcoal, with neutral panels and text
replacing the green cast. Teal accents still identify actions and active states,
and secondary text retains readable contrast.

### Releases that explain the upgrade

GitHub releases now include reviewed highlights, a categorized changelog,
versioned container references, upgrade guidance, and links to image digests and
verification files. Highlights come from the changes since the previous
published release, so failed drafts and reruns do not lose or duplicate them.
