# Relay brand direction

Status: approved product name; voice and visual direction open for refinement\
Parent brand: ZafTech\
Domain: `relay.zaftech.co`

## Name

**Relay** is the canonical product name.

The name works across the full product rather than only one MVP feature:

- Files move from clients to durable storage.
- Jobs move from queued to completed.
- Generated assets move back through signed URLs.
- Status moves live to the dashboard.
- Future streaming remains consistent with the name.

Use the lockup **Relay by ZafTech** when parent-company trust matters. Use
**Relay** alone inside the authenticated product once context is established.

## Positioning

Relay is production infrastructure for MCP clients and engineering teams that
need somewhere durable to put files and long-running work.

It is not positioned as:

- A consumer cloud drive
- A general file-sharing app
- A workflow automation canvas
- An AI image generator with storage attached
- A generic developer platform claiming to replace every service

## Core message

Recommended lead:

> Files in. Work underway. URLs out.

Supporting statement:

> Relay gives MCP clients durable object storage, observable background jobs,
> and signed delivery URLs—without routing file bytes through your application.

Alternative short lines:

- Durable storage for work that does not finish in one request.
- Store the file. Run the work. Return the result.
- Storage and background work, exposed cleanly to MCP.

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
input -> stored object -> immutable versions -> queued work -> result -> signed URL
```

Use horizontal connector lines, node states, version stacks, and precise
operational labels. Avoid cloud illustrations, floating 3D shapes, glass cards,
and decorative gradients.

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

The mark remains a design concept until a generated option is reviewed and
approved.

## Imagery guidance

Stock photography is not recommended for the initial landing page. It would make
an infrastructure product feel generic and would not explain the workflow.

Preferred assets:

1. Custom SVG operational diagram for the hero
2. Custom thin-line feature icons
3. Real dashboard screenshots once `/dashboard` exists
4. Real generated-image examples once the provider flow exists
5. Real architecture or status captures for documentation

Generated illustrative imagery is optional for demonstrating image-generation
output, but it should not become the primary brand device.

The user does not need to source stock imagery for the first landing design.
Later, provide real product captures rather than stock whenever possible.

## Public route hierarchy

```text
/             Marketing landing page
/dashboard    Authenticated application
/docs         Documentation
/changelog    Published product changes
/status       Operational status
/sign-in      Browser sign-in
```

The public landing page must not use dashboard navigation or look like an
authenticated application shell.

## Landing-page content structure

1. Compact Relay by ZafTech header
2. Direct hero and custom operational SVG
3. Concrete infrastructure proof strip
4. Request-to-result workflow
5. Immutable file versioning
6. Observable background jobs
7. MCP tool contract
8. Provider and deployment compatibility
9. Entitlements and usage-control preview
10. Security baseline
11. Changelog preview
12. Final CTA and ZafTech legal footer

## Calls to action

Primary:

- Start building
- Open dashboard

Secondary:

- Read the MCP docs
- View changelog
- Read documentation

Avoid “Learn more” when a destination can be named precisely.
