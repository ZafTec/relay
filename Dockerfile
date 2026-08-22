FROM denoland/deno:2.9.4 AS build

WORKDIR /src

COPY deno.json deno.lock ./
COPY apps ./apps
COPY packages ./packages
COPY src ./src

# --frozen makes an unexpected lockfile drift a build failure instead of a
# silent rewrite -- deno.json's own "lock": { "frozen": true } already
# defaults every deno command to this, but it's repeated explicitly here
# so this build stays reproducible even if that default is ever changed
# without someone re-reading this file too.
RUN mkdir -p /out && \
    deno compile \
      --frozen \
      --allow-env \
      --allow-net \
      --output /out/relay \
      src/main.ts

FROM debian:bookworm-slim AS runtime

RUN apt-get update && \
    apt-get install --yes --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /out/relay /app/relay

# Required OCI labels per
# docs/implementation-handoff/09-ci-release-deployment.md. VERSION/
# REVISION/CREATED are injected at build time (CI passes the real
# release SemVer, git SHA, and build timestamp); the defaults here are
# only for a local `docker build` with no --build-arg overrides.
ARG APP_VERSION=development
ARG GIT_SHA=unknown
ARG IMAGE_CREATED=1970-01-01T00:00:00Z
LABEL org.opencontainers.image.title="Relay" \
      org.opencontainers.image.description="Curated tool and artifact registry for AI agents" \
      org.opencontainers.image.source="https://github.com/ZafTec/relay" \
      org.opencontainers.image.documentation="https://github.com/ZafTec/relay/tree/main/docs" \
      org.opencontainers.image.vendor="ZafTec" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${IMAGE_CREATED}" \
      org.opencontainers.image.licenses="UNLICENSED"

USER 65532:65532
EXPOSE 8000

# Execs the compiled binary's own `healthcheck` command rather than
# curling the api process's /health/ready over the network -- works
# identically for the api and worker images (both depend on PostgreSQL
# reachability and migration state, neither dependency needs an HTTP
# round trip to check), needs no extra tooling in this image, and never
# exposes readiness on the network for a container-local check per
# 09-ci-release-deployment.md's "Do not publicly expose readiness unless
# there is a deliberate operational need."
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/app/relay", "healthcheck"]

ENTRYPOINT ["/app/relay"]
CMD ["api"]
