FROM alpine:3.23@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40 AS certificates

FROM denoland/deno:2.9.4@sha256:c777b4b225501a61074837e90a826a58f99124837824023cd60334b1e2374498 AS build

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

FROM build AS test

COPY scripts ./scripts
RUN deno test \
      --frozen \
      --no-run \
      --allow-env \
      --allow-net \
      apps/api apps/worker packages src && \
    deno cache \
      --frozen \
      scripts/dev/check-live.ts \
      scripts/ci/api-container-smoke.ts \
      scripts/ci/web-container-smoke.ts

ENTRYPOINT ["deno"]
CMD ["task", "check:live"]

FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 AS runtime

WORKDIR /app
COPY --from=certificates /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/relay /app/relay
COPY apps/api/docker-entrypoint.sh /app/relay-entrypoint
RUN sed -i 's/\r$//' /app/relay-entrypoint && \
    chmod 0555 /app/relay-entrypoint

# Required OCI labels per
# docs/versioning.md. VERSION/
# REVISION/CREATED are injected at build time (CI passes the real
# release SemVer, git SHA, and build timestamp); the defaults here are
# only for a local `docker build` with no --build-arg overrides.
ARG APP_VERSION=development
ARG GIT_SHA=unknown
ARG IMAGE_CREATED=1970-01-01T00:00:00Z
ENV APP_VERSION="${APP_VERSION}" \
    GIT_SHA="${GIT_SHA}"
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

# Execs the compiled binary's own role-aware `healthcheck` command rather than
# curling the API process over the network. RELAY_PROCESS_ROLE is set explicitly
# by Compose for API/worker containers; each probe checks PostgreSQL and the
# migration ledger, Redis, and its role-scoped MinIO credentials/bucket
# versioning. The one-shot migration service disables this image healthcheck.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/app/relay-entrypoint", "healthcheck"]

ENTRYPOINT ["/app/relay-entrypoint"]
CMD ["api"]
