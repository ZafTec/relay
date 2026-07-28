FROM denoland/deno:2.9.4 AS build

WORKDIR /src

COPY deno.json deno.lock ./
COPY apps ./apps
COPY packages ./packages
COPY src ./src

RUN mkdir -p /out && \
    deno compile \
      --allow-env \
      --allow-net \
      --output /out/relay
      src/main.ts

FROM debian:bookworm-slim AS runtime

RUN apt-get update && \
    apt-get install --yes --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /out/relay /app/relay

USER 65532:65532
EXPOSE 8000

ENTRYPOINT ["/app/relay"]
CMD ["api"]
