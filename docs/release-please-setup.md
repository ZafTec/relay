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

## 2. Configure image publication

In [repository Actions settings](https://github.com/ZafTec/relay/settings/secrets/actions):

- Add repository secret `DOCKERHUB_TOKEN`, with Read & Write access to both
  image repositories and no Delete permission.
- Add repository secret `DOCKERHUB_USERNAME`. It controls both the registry login
  and the destination namespace: `<username>/relay-backend` and
  `<username>/relay-web`.
- Optional public browser telemetry settings: set `VITE_APP_ORIGIN` to the exact
  application origin (without a trailing slash) and `VITE_FARO_COLLECTOR_URL` to
  the HTTPS collector URL. The web build embeds these public values; never put
  secrets in them. Telemetry is disabled when either is unset or the browser's
  origin does not match. The user must also allow analytics in Cookie settings.
  Local builds leave both unset by default.

Store the public frontend settings as repository variables. The workflow does not
depend on GitHub environments, which GitHub Free does not support for private
repositories. Secret values cannot be read back from GitHub to move them.

Create `relay-backend` and `relay-web` in the account named by
`DOCKERHUB_USERNAME`. Optional repository variables `DOCKERHUB_BACKEND_REPOSITORY`
and `DOCKERHUB_WEB_REPOSITORY` change the repository names within that account.
Configure immutable SemVer, `git-<full-sha>`, and `candidate-<run-id>` tags, leaving
`latest` mutable. Confirm registry support for OCI attestations/referrers and
the expected visibility of both image repositories separately from GitHub.

GitHub-signed attestations require **GitHub Enterprise Cloud** for private
repositories. Private releases use the images' native BuildKit provenance by
default and retain SBOMs, scans, and digest verification. On Enterprise Cloud, set
repository variable `RELAY_GITHUB_ATTESTATIONS_ENABLED=true` to also require
GitHub-signed attestations. Public releases always require them. A public Docker
image remains downloadable even when its GitHub source repository is private.

In [repository rulesets](https://github.com/ZafTec/relay/settings/rules), protect
`main` with the required CI aggregate. Protect `v*` release tags from deletion and
force updates, and permit the release App to create them. Keep tag-creation
restrictions separate from immutable-tag rules so a creation bypass does not
also bypass deletion/update restrictions. Ensure the App can open release PRs
and apply Release Please labels under organization policy.

## 3. Run a release

1. Review and merge the implementation PR when its CI is green and the release
   credentials are configured. Use its Conventional Commit title if squash merging.
   CI runs only on pull requests. The merge updates `main`, which triggers Release
   Please without rerunning CI; this also works when direct pushes are prohibited.
2. The **Release Please** workflow runs on `main` and opens a release PR updating
   `CHANGELOG.md`, `version.txt`, and `.release-please-manifest.json` to the next version.
3. Review the release PR and CI. Merging that PR authorizes release creation:
   Release Please creates the version tag and a draft GitHub release.
4. **Release images** builds the
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

## Publication boundary

Release Please prepares versions and a changelog grouped by Conventional Commit
type. Descriptive squash titles explain individual changes; reviewed
[release highlights](release-notes/README.md) provide the user impact and upgrade
steps that a PR-title list cannot capture. The image workflow adds versioned
container references, deployment guidance, and links to verification files to
the draft before publication. Reruns replace these generated sections without
duplicating them. Failed drafts do not consume a release's highlights.

The image workflow publishes
verified artifacts and a manifest identifying the paired image digests. Host
deployment files, credentials, dashboards, and operator procedures are managed
outside this repository. See the [release/versioning policy](versioning.md).
