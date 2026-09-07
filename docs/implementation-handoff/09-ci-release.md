# CI and releases

CI runs on pull requests and validates source, browser behavior, isolated
integration containers, security, workflows, and release scripts. The required
aggregate fails if any lane fails.

Merges to protected `main` trigger Google Release Please. Merging its release PR
creates a version tag and draft release. The image workflow builds the backend
and web from that revision, scans them, records provenance and paired image
digests, and publishes the release after verification.

See the current [release setup](../release-please-setup.md) and
[versioning policy](../versioning.md) for the maintained release contract.

Repository Compose files are for local development and isolated tests. Host
deployment configuration, environment files, proxy settings, dashboards, and
operator runbooks are maintained outside Git. Image publication does not deploy
the application.
