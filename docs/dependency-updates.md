# Dependency update reporting

Dependency updates are proposed in issues, then implemented deliberately after
review. Dependabot version PRs are disabled for npm and GitHub Actions using
`open-pull-requests-limit: 0` in `.github/dependabot.yml`. That configuration takes
effect after it reaches the default branch.

The `Dependency update report` workflow runs every Monday at 06:23 UTC and can be
started manually on the default branch. It checks the exact versions in
`apps/web/package.json` and the version comments beside full SHA pins in
`.github/workflows`. It creates or refreshes one open **Review dependency updates**
issue. Notes outside its generated section are preserved. It does not install
packages, change pins or lockfiles, open PRs, or close the issue.

The workflow uses the repository's built-in token with `contents: read` and
`issues: write`; no App or additional secret is needed. A registry or GitHub lookup
failure fails the run before the issue is changed. Check failed scheduled runs if
the report stops refreshing. Unsupported version ranges or Action pins without
exact version comments also fail visibly.

This report monitors direct frontend dependencies and GitHub Actions, matching the
previous Dependabot configuration. It does not scan transitive dependencies, Deno
imports, or container tags. When updating Better Auth, review the related backend
imports and lockfile as well. The existing CI vulnerability scans remain in place.

Dependabot **security update PRs** have a separate repository setting; the version
PR limit does not disable them. Keep automatic security updates disabled in
repository **Settings → Code security → Dependabot** if issue-only maintenance is
required. Vulnerability alerts can be enabled independently. At the time this
workflow was added, automatic security updates and vulnerability alerts were both
disabled in the repository; neither setting was changed by this implementation.

Google Release Please is separate: its release PR remains the deliberate approval
step requested for versioning and publication. See
[Release Please setup](release-please-setup.md).

To preview the report locally without changing GitHub:

```sh
deno run --allow-read=apps/web/package.json,.github/workflows \
  --allow-env=GH_TOKEN,GITHUB_REPOSITORY \
  --allow-net=api.github.com,registry.npmjs.org scripts/dependencies/report.ts
```

An optional `GH_TOKEN` raises GitHub's API rate limit. Add `--publish` only when
intending to create or update the issue, with `GITHUB_REPOSITORY` and `GH_TOKEN`
set. The recurring workflow begins after this change is merged to the default
branch.
