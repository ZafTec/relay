# Writing release highlights

For a user-visible change, add a uniquely named Markdown file in this directory,
such as `mcp-catalog-and-dark-theme.md`. Start with a `###` heading, explain the
trigger and resulting behavior in plain language, and include any upgrade steps.
Use lowercase letters, digits, and hyphens in filenames. Keep published files
in place; add a new file for later changes.

During image publication, Relay includes files added since the newest older
published stable release that is an ancestor of the tagged source. Failed drafts
and prereleases do not consume highlights. The first release includes every
highlight. The workflow reads the tagged source, so future working-tree changes
cannot leak into older release notes.

These reviewed highlights appear above Release Please's categorized changelog.
The workflow then adds the verified backend/web references, deployment guidance,
and links to release evidence. Reruns replace generated sections while preserving
the changelog and any manual text outside those sections. Publication remains the
final workflow operation.

This controls GitHub releases. Relay's in-app changelog retains its separate
superadmin review and publication process.
