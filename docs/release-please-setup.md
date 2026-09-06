# Set up Google Release Please

Relay already uses Google's official
[`googleapis/release-please-action`](https://github.com/googleapis/release-please-action)
in [release-please.yml](../.github/workflows/release-please.yml). Keep the existing
repository-wide `simple` release configuration and bootstrap manifest. The first
product release is `0.1.0`.

## 1. Install a release GitHub App

An organization owner can create the App from
[ZafTec's GitHub App settings](https://github.com/organizations/ZafTec/settings/apps).

- Select **New GitHub App**, use a recognizable name such as **ZafTec Relay
  Releases**, and set `https://github.com/ZafTec/relay` as its homepage.
- Uncheck **Active** under **Webhook**. Leave user authorization callbacks empty;
  this App authenticates the release workflow rather than interactive sign-in.
- Give it repository **Contents**, **Pull requests**, and **Issues** permissions,
  all **Read and write**. Metadata read access is implicit. No organization
  permissions are needed.
- Choose **Only on this account** for where the App can be installed, then create
  it. Open **Install App**, select ZafTec, and install it on **Only select
  repositories → relay**.
- On the App's **General** page, copy the numeric **App ID**. This is the value for
  `RELEASE_APP_ID`.
- On the same page, find **Private keys → Generate a private key**. GitHub downloads
  a `.pem` file. Its complete contents, including the BEGIN/END lines and actual
  line breaks, are the value for `RELEASE_APP_PRIVATE_KEY`.

In [Relay's Actions secrets](https://github.com/ZafTec/relay/settings/secrets/actions),
add `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY` (the complete PEM). Organization
secrets are also supported when their repository access includes Relay. Never
commit the private key or put it into a workflow file.

Use **New repository secret** for each value. These must be repository or
organization Actions secrets because the Release Please job does not use the
`release` environment. A local `.env` file is not read by GitHub Actions.

The workflow creates a short-lived installation token scoped only to Relay. This
is needed because a tag created using the default `GITHUB_TOKEN` would not trigger
the separate image-publication workflow.

## 2. Configure the release boundary

In [repository environments](https://github.com/ZafTec/relay/settings/environments),
create an environment named exactly **release**:

- Add required reviewers where the GitHub plan supports them.
- If using selected deployment branches/tags, allow release tags matching
  `v*.*.*`; do not configure it for `main` only, since image jobs run on tags.
- Add environment secret `DOCKERHUB_TOKEN`, with Read & Write access to both
  image repositories and no Delete permission.
- Set environment variable `DOCKERHUB_USERNAME`, or use an environment secret
  of the same name.

Repository credentials already work as inherited fallbacks, but the release
environment is the documented boundary for publication credentials. Secret values
cannot be read back from GitHub to move them; re-enter the token from its source.

Create Docker Hub repositories `zaftec/relay-backend` and `zaftec/relay-web`, or set
`DOCKERHUB_NAMESPACE`, `DOCKERHUB_BACKEND_REPOSITORY`, and
`DOCKERHUB_WEB_REPOSITORY` environment variables to the intended destinations.
Configure immutable SemVer, `git-<full-sha>`, and `candidate-<run-id>` tags, leaving
`latest` mutable. Confirm registry support for OCI attestations/referrers and
GitHub artifact-attestation availability for this private repository's plan.

The GitHub build-provenance action requires **GitHub Enterprise Cloud** for
private-repository attestations. Public repositories are supported on current
GitHub plans. Saving an environment and its tag policy does not establish access
to the attestation service. Resolve this requirement before merging the generated
release PR.

In [repository rulesets](https://github.com/ZafTec/relay/settings/rules), protect
`main` with the required CI aggregate. Protect `v*` release tags from deletion and
force updates, and permit the release App to create them. Keep tag-creation
restrictions separate from immutable-tag rules so a creation bypass does not
also bypass deletion/update restrictions. Ensure the App can open release PRs
and apply Release Please labels under organization policy.

## 3. Run the first release

1. Finish and review [PR #35](https://github.com/ZafTec/relay/pull/35), then merge it
   when its CI is green and the release credentials are configured. Use its
   Conventional Commit title if squash merging.
   CI runs only on pull requests. The merge updates `main`, which triggers Release
   Please without rerunning CI; this also works when direct pushes are prohibited.
2. The **Release Please** workflow runs on `main` and opens a release PR updating
   `CHANGELOG.md`, `version.txt`, and `.release-please-manifest.json` to `0.1.0`.
3. Review the release PR and CI. Merging that PR authorizes release creation:
   Release Please creates `v0.1.0` and a draft GitHub release.
4. **Release images** waits for any `release` environment review, builds the
   backend/web pair, scans it, attaches provenance and release evidence, and
   publishes the GitHub release only after every publication check succeeds.

For later changes, `feat:` increments the minor version and `fix:` / `perf:` the
patch version, including during `0.x`. A failed setup run can be rerun from
[Actions](https://github.com/ZafTec/relay/actions) after correcting configuration;
do not create a manual version tag to work around it.

A rerun uses the original tagged commit and workflow. If the failure requires a
code or workflow fix, merge that fix through a PR and let Release Please prepare
the next version. Keep the failed release as an unpublished draft and preserve
its tag. Changing `main` does not repair a rerun of an older tag.

## Production deployment is a separate step

Release Please prepares versions and release notes. The image workflow publishes
verified artifacts. Neither provisions or deploys a VPS. Deploy the paired image
digests in the resulting `release-manifest.json` using the existing deployment
runbook, after host configuration, production secrets, migration/backup checks,
OAuth callbacks, and operational readiness have been verified. See the approved
[release/versioning policy](versioning.md) and
[deployment handoff](implementation-handoff/09-ci-release-deployment.md).
