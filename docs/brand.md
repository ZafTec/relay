# Relay brand direction

Status: approved product name and voice; Ledger v3 is the current registry-first
implementation reference with documented fixture exceptions\
Parent brand: ZafTech\
Hosted origin: configured outside the repository

## Name

**Relay** is the canonical product name.

The name works across the full product rather than only one MVP feature:

- Agent requests move through a curated tool contract.
- Runs move from accepted to completed with durable status.
- Provider outputs move into Relay-owned artifact records.
- Managed URLs relay those artifacts to people and systems.
- Future streaming remains consistent with the name.

Use the lockup **Relay by ZafTech** when parent-company trust matters. Use
**Relay** alone inside the authenticated product once context is established.

## Positioning

Relay is production infrastructure for AI agents and engineering teams that need
a curated set of long-running tools, durable outputs, managed delivery, and
usage they can explain.

Image generation is the first tool family, not the limit of the product. Storage
is the durable substrate for inputs and artifacts rather than the primary user
experience.

Relay is not positioned as:

- A consumer cloud drive
- A general file-sharing app
- A workflow automation canvas
- A thin proxy over one image provider
- A marketplace for unreviewed executable code
- A generic developer platform claiming to replace every service

## Core message

Recommended lead:

> Call the tool. Track the work. Share the result.

Supporting statement:

> Relay gives AI agents curated asynchronous tools, stores every output as a
> durable artifact, meters each run, and returns managed URLs.

Alternative short lines:

- Tools agents can call. Artifacts teams can trust.
- Long-running tools. Durable outputs. Managed delivery.
- Agent work that survives the request.

## Voice sampled from ZafTech

ZafTech's strongest language is direct, operational, and specific. It earns
trust through implementation detail rather than adjectives.

Examples of the parent pattern:

- “Production systems for teams that can't afford an outage.”
- “Designed, shipped, and on-called by the engineers who wrote them.”
- “APIs and services with predictable latency, real observability, and a clear
  migration path when the schema changes.”
- “Bills you can reason about.”

Relay should preserve that character.

### Voice principles

1. **State what the system does.** Prefer “Upload directly to S3” over
   “Seamlessly manage your assets.”
2. **Use operational proof.** Mention immutable versions, job heartbeats, signed
   URLs, and trace context where relevant.
3. **Keep sentences short.** One claim per sentence.
4. **Avoid inflated certainty.** Do not invent uptime, latency, security
   certifications, customer counts, or savings.
5. **Sound like the team operating it.** Explain failure behavior and recovery,
   not only the happy path.
6. **Separate current capability from roadmap.** Mark transformations and
   streaming as future work until they exist.

### Avoid

- Revolutionary
- Cutting-edge
- Seamless
- Effortless
- Game-changing
- Best-in-class
- Limitless
- Enterprise-grade without evidence
- AI-powered when a more precise description exists

## Visual relationship to ZafTech

Relay should visibly belong to ZafTech without becoming a clone of the company
site.

### Foundation

- Onyx-black background: `#101410`
- Slightly lighter green-black surfaces
- Warm ivory primary text
- Spruce accent near `#7CC8B8`
- Restrained copper for selected emphasis
- Plus Jakarta Sans for headings and body text
- Monospace labels for statuses, endpoints, versions, dates, and metrics
- Thin one-pixel borders
- Mostly square corners
- Strong grid alignment
- Generous negative space

### Product-specific distinction

Relay's visual motif is **movement through durable stages**:

```text
agent -> tool registry -> asynchronous run -> output set -> artifact -> managed URL
```

Use horizontal connector lines, node states, version stacks, artifact previews,
and precise operational labels. The visual system should make the registry,
provider boundary, metering checkpoint, and one-to-many outputs legible. Avoid
cloud illustrations, floating 3D shapes, glass cards, and decorative gradients.

## Product mark brief

The mark should combine:

- Three offset layers representing immutable versions
- One connecting path representing work moving through the system
- One outgoing endpoint representing delivery

Requirements:

- Recognizable at favicon size
- Works in one color
- Does not depend on an `R` monogram
- Can animate as a simple line progression without requiring animation
- Has a square view box
- Avoids similarity to generic sync, share, or play icons

The Ledger mark is the current approved identity foundation. A registry-first
design revision may refine its application and supporting icon language, but
must not silently replace the mark without owner approval.

## Imagery guidance

Stock photography is not recommended for the initial landing page. It would make
an infrastructure product feel generic and would not explain the workflow.

Preferred assets:

1. Custom SVG operational diagram for the hero
2. Custom thin-line feature icons
3. Real dashboard screenshots once `/dashboard` exists
4. Representative generated-image examples from approved Relay providers
5. Real architecture or status captures for documentation

Generated-image examples are required to explain the initial product family, but
they should demonstrate tools and artifacts rather than become decorative stock
imagery or the sole brand device.

The user does not need to source stock imagery for the first landing design.
Later, provide real product captures rather than stock whenever possible.

## Route hierarchy

```text
/             Marketing landing page
/dashboard    Authenticated application
/docs         Documentation
/changelog    Published product changes
/admin/status Operational status (superadmins only)
/sign-in      Browser sign-in
```

Operational status belongs only in the superadmin console. Do not link it from
public navigation or workspace navigation.

The public landing page must not use dashboard navigation or look like an
authenticated application shell.

## Landing-page content structure

1. Compact Relay by ZafTech header
2. Direct hero and custom registry-to-artifact SVG
3. Representative image outputs from more than one curated tool
4. Tool discovery and typed contract
5. Estimate, reservation, and asynchronous run workflow
6. Observable status, attempts, retries, and cancellation
7. Durable multi-output artifacts and managed share URLs
8. MCP and HTTP integration proof
9. Provider, storage, and deployment compatibility
10. Entitlements, metering, and usage receipts
11. Security and workspace-isolation baseline
12. Published changelog preview
13. Final CTA and ZafTech legal footer

## Calls to action

Primary:

- Start building
- Open dashboard

Secondary:

- Read the MCP docs
- View changelog
- Read documentation

Avoid “Learn more” when a destination can be named precisely.
