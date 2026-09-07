FROM node:24.19.0-alpine3.23@sha256:244cc2b53f46f9e876304391d17682b0ddae9ac33491f4857e25e35a36ba7995 AS build

WORKDIR /src

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts ./
COPY public ./public
COPY scripts ./scripts
COPY src ./src
ARG APP_VERSION=development
ARG VITE_APP_ORIGIN
ARG VITE_FARO_COLLECTOR_URL
ENV VITE_APP_VERSION=${APP_VERSION}
ENV VITE_APP_ORIGIN=${VITE_APP_ORIGIN}
ENV VITE_FARO_COLLECTOR_URL=${VITE_FARO_COLLECTOR_URL}
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.31.4-alpine@sha256:d9083fe47768377ef55dedafd67d4da7c2f2bc2bece7554954f29359deb0dce9 AS runtime

ARG APP_VERSION=development
ARG GIT_SHA=unknown
ARG IMAGE_CREATED=1970-01-01T00:00:00Z

# The pinned base still ships an Alpine 3.24 libexpat with a known HIGH CVE
# fixed upstream in the same package repo; upgrade in place rather than
# waiting on nginxinc to rebuild the tag.
USER 0
RUN apk update && apk upgrade --no-cache && rm -rf /var/cache/apk/*
USER 101

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build --chown=101:101 /src/dist /usr/share/nginx/html

LABEL org.opencontainers.image.title="Relay Web" \
      org.opencontainers.image.description="Relay browser application" \
      org.opencontainers.image.source="https://github.com/ZafTec/relay" \
      org.opencontainers.image.documentation="https://github.com/ZafTec/relay/tree/main/docs" \
      org.opencontainers.image.vendor="ZafTec" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${IMAGE_CREATED}" \
      org.opencontainers.image.licenses="UNLICENSED"

USER 101:101
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "-T", "3", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
