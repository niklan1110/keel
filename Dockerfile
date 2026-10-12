# syntax=docker/dockerfile:1.25@sha256:0adf442eae370b6087e08edc7c50b552d80ddf261576f4ebd6421006b2461f12

# Three images are built from this file:
#   keel            (default target) runs every core service; the command picks
#                   which one: migrate | gateway | rest | auth | storage | realtime | studio
#   keel-functions  (--target functions) runs edge functions with Deno
#   keel-postgres   (--target db) is keel-db: Postgres with pgvector and PostGIS

# Every base image is pinned by digest. Dependabot proposes new digests and
# versions (.github/dependabot.yml). keel-postgres and the keel image (for
# pg_dump) both start from the one Postgres image below, so backups always
# match the server's version (CI checks there is only one).
FROM postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24 AS postgres
FROM postgrest/postgrest:v12.2.12@sha256:5f4ce744539bbba786b4e24dbbd95bdb2a956dcf568c5374995a0ff4a68f5bd2 AS postgrest
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS node
FROM denoland/deno:bin-2.9.7@sha256:bc5aa4466e21b6d3021226a85ba2e1911f7c386254d97b9d797903ab74edace2 AS deno
FROM cloudflare/cloudflared:2026.10.0@sha256:9b49eed8f62806d5d45ddf59ecefb5710429598ea6d3fcccd2af938f621b2b07 AS cloudflared

# The JavaScript build is platform independent, so it runs natively on the
# build machine even when producing arm64 images.
FROM --platform=$BUILDPLATFORM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY studio/package.json studio/
COPY website/package.json website/
COPY tests/e2e/package.json tests/e2e/
# No lifecycle scripts: no dependency needs one (esbuild's binary comes from its
# per-platform optional package), and they would run third-party code here.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY server server
COPY studio studio
COPY website website
COPY deploy deploy
COPY keel keel
# Shown in the built-in docs and Studio's AI agent prompt: where the images are
# published (e.g. ghcr.io/my-org), the public website, if there is one, and
# the source repository (owner/name, for links to its releases).
ARG KEEL_IMAGE_PREFIX=""
ARG KEEL_SITE_URL=""
ARG KEEL_SOURCE_REPO=""
RUN npm run build -w server && npm run build -w studio && npm run build -w website

FROM --platform=$BUILDPLATFORM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY studio/package.json studio/
COPY website/package.json website/
COPY tests/e2e/package.json tests/e2e/
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# Edge functions: the Node supervisor plus Deno. Debian based, because the
# official Deno binary needs glibc. The JavaScript dependencies are pure JS,
# so the node_modules built above work here too.
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS functions
COPY --from=deno /deno /usr/local/bin/deno
WORKDIR /app
ENV NODE_ENV=production \
    KEEL_FUNCTIONS_ROOT=/var/lib/keel/functions \
    DENO_NO_UPDATE_CHECK=1
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/runtime ./server/runtime
# Debian security fixes released since the pinned base image was built.
RUN apt-get update && apt-get upgrade -y --no-install-recommends && rm -rf /var/lib/apt/lists/*
# uid 1000 ("node" in this base image) matches the keel user of the main image.
RUN mkdir -p /var/lib/keel/functions /var/lib/keel/credentials/keel_functions_admin && chown -R 1000:1000 /var/lib/keel
USER 1000:1000
# This image runs one service, so it can check itself. (The keel image runs a
# different service per container; its health checks are in the compose files.)
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:9000/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# Release metadata from the release workflow (empty in local builds): the
# version Keel reports, and the OCI labels shown by docker inspect.
ARG KEEL_BUILD_VERSION=""
ARG KEEL_BUILD_REVISION=""
ARG KEEL_SOURCE_REPO=""
LABEL org.opencontainers.image.title="keel-functions" \
      org.opencontainers.image.description="Keel edge functions (Deno), part of a self-hosted backend that speaks the Supabase APIs" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${KEEL_BUILD_VERSION}" \
      org.opencontainers.image.revision="${KEEL_BUILD_REVISION}" \
      org.opencontainers.image.source="${KEEL_SOURCE_REPO:+https://github.com/${KEEL_SOURCE_REPO}}"
ENV KEEL_BUILD_VERSION="${KEEL_BUILD_VERSION}" \
    KEEL_SOURCE_REPO="${KEEL_SOURCE_REPO}"
ENTRYPOINT ["node", "/app/server/dist/main.js"]
CMD ["functions"]

# keel-postgres: extensions apps expect from Supabase, built against the
# server's own headers. Sources are pinned by version and checksum.
#   pgvector  vector similarity search (create extension vector)
#   PostGIS   geography and geometry, without raster (GDAL would add ~150 MB)
# with_llvm=no: no JIT bitcode (it would need clang); OPTFLAGS="": no
# -march=native, so the image runs on any CPU of its architecture.
FROM postgres AS db-build
ARG PGVECTOR_VERSION=0.8.7
ARG POSTGIS_VERSION=3.6.4
ADD --checksum=sha256:cac0b10c360f05b2d521200105ba3697e773d4cd3731f5a915a7e37ebe0bea85 \
    https://github.com/pgvector/pgvector/archive/refs/tags/v${PGVECTOR_VERSION}.tar.gz /src/pgvector.tar.gz
ADD --checksum=sha256:ed8dc6679f1e06f7b113592b04cde2a7e00f1b1e681294c8ca2204058990cec6 \
    https://download.osgeo.org/postgis/source/postgis-${POSTGIS_VERSION}.tar.gz /src/postgis.tar.gz
RUN apk add --no-cache build-base perl geos-dev proj-dev json-c-dev protobuf-c-dev libxml2-dev
WORKDIR /src/pgvector
RUN tar -xzf /src/pgvector.tar.gz --strip-components=1 \
 && make with_llvm=no OPTFLAGS="" \
 && make with_llvm=no DESTDIR=/out install
# Trusted, so a project's owner role (migrations, as on Supabase) can create
# it. Its install script only creates its own types, C functions, operators
# and access methods; it runs no queries, so objects the owner could plant in
# the target schema can't make it run their code as the superuser. PostGIS'
# script does run queries, so PostGIS stays superuser-only (Studio's SQL editor).
RUN echo 'trusted = true' >> /out/usr/local/share/postgresql/extension/vector.control
WORKDIR /src/postgis
RUN tar -xzf /src/postgis.tar.gz --strip-components=1 \
 && ./configure --without-raster --without-address-standardizer --without-gui --without-phony-revision \
 && make -j"$(nproc)" with_llvm=no \
 && make with_llvm=no DESTDIR=/out install
# Left out: headers, docs, and scripts CREATE EXTENSION never runs (converting
# a pre-extension install, non-extension installs and uninstalls). Debug
# symbols are stripped.
RUN rm -rf /out/usr/local/include /out/usr/local/share/doc /out/usr/local/share/man \
           /out/usr/local/share/postgresql/extension/*--unpackaged--* /out/usr/local/share/postgresql/contrib \
 && strip --strip-unneeded /out/usr/local/lib/postgresql/*.so /out/usr/local/bin/shp2pgsql /out/usr/local/bin/pgsql2shp

FROM postgres AS db
COPY --from=db-build /out/ /
# PostGIS' libraries, and Alpine security fixes released since the pinned base
# image was built. Postgres itself is in /usr/local, not an Alpine package.
# The entrypoint scripts drop root with `gosu postgres ...`; they use su-exec
# (C, from Alpine) instead, as the image itself once did: gosu is a Go binary
# that brings Go's CVEs into scans. The build fails if the scripts change.
RUN apk add --no-cache geos proj json-c protobuf-c libxml2 su-exec \
 && apk upgrade --no-cache \
 && cd /usr/local/bin \
 && sed -i 's/exec gosu postgres /exec su-exec postgres /' docker-entrypoint.sh docker-ensure-initdb.sh docker-enforce-initdb.sh \
 && grep -q 'exec su-exec postgres ' docker-entrypoint.sh \
 && ! grep -n gosu docker-entrypoint.sh docker-ensure-initdb.sh docker-enforce-initdb.sh \
 && rm gosu
ARG KEEL_BUILD_VERSION=""
ARG KEEL_BUILD_REVISION=""
ARG KEEL_SOURCE_REPO=""
LABEL org.opencontainers.image.title="keel-postgres" \
      org.opencontainers.image.description="Postgres for Keel (keel-db), with pgvector and PostGIS" \
      org.opencontainers.image.licenses="PostgreSQL AND GPL-2.0-or-later" \
      org.opencontainers.image.version="${KEEL_BUILD_VERSION}" \
      org.opencontainers.image.revision="${KEEL_BUILD_REVISION}" \
      org.opencontainers.image.source="${KEEL_SOURCE_REPO:+https://github.com/${KEEL_SOURCE_REPO}}"

# The runtime starts from the Postgres image's filesystem so pg_dump and
# pg_restore (used for backups) always match the server's major version.
# Copying the filesystem into scratch drops the image's VOLUME declaration,
# so Keel containers don't get a stray anonymous data volume. Node is copied in.
FROM postgres AS pgbase
# openssl makes keel-db's TLS certificate on first start (keel-db-tls).
# gosu and the entrypoint only start a Postgres server, which this image never
# does; gosu is a Go binary, so it would bring Go's own CVEs into scans.
RUN apk add --no-cache openssl \
 && rm -f /usr/local/bin/gosu /usr/local/bin/docker-entrypoint.sh /usr/local/bin/docker-ensure-initdb.sh /usr/local/bin/docker-enforce-initdb.sh /docker-entrypoint.sh
FROM scratch
COPY --from=pgbase / /
COPY --from=node /usr/local/bin/node /usr/local/bin/node
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    LANG=en_US.utf8
COPY --from=postgrest /bin/postgrest /usr/local/bin/postgrest
# Cloudflare's tunnel client, run by keel-tunnel once a token is saved in Studio.
COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared
WORKDIR /app
ENV NODE_ENV=production \
    KEEL_POSTGREST_BIN=/usr/local/bin/postgrest \
    KEEL_STUDIO_STATIC=/app/studio/dist \
    KEEL_DOCS_STATIC=/app/website/dist
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/sql ./server/sql
COPY --from=build /app/studio/dist ./studio/dist
COPY --from=build /app/website/.vitepress/dist ./website/dist
# credentials/<role>: each service role's database password, written by
# keel-migrate into a volume that only the service using that role mounts.
RUN adduser -D -u 1000 keel \
 && mkdir -p /var/lib/keel/storage /var/lib/keel/backups /var/lib/keel/tunnel \
 && for role in authenticator keel_auth_admin keel_storage_admin keel_realtime_admin keel_functions_admin keel_egress_admin; do mkdir -p /var/lib/keel/credentials/$role; done \
 && chown -R keel:keel /var/lib/keel
USER keel
# Release metadata from the release workflow (empty in local builds): the
# version Keel reports, and the OCI labels shown by docker inspect.
ARG KEEL_BUILD_VERSION=""
ARG KEEL_BUILD_REVISION=""
ARG KEEL_SOURCE_REPO=""
LABEL org.opencontainers.image.title="keel" \
      org.opencontainers.image.description="Keel, a self-hosted backend that speaks the Supabase APIs" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${KEEL_BUILD_VERSION}" \
      org.opencontainers.image.revision="${KEEL_BUILD_REVISION}" \
      org.opencontainers.image.source="${KEEL_SOURCE_REPO:+https://github.com/${KEEL_SOURCE_REPO}}"
ENV KEEL_BUILD_VERSION="${KEEL_BUILD_VERSION}" \
    KEEL_SOURCE_REPO="${KEEL_SOURCE_REPO}"
# Run with `init: true` (see docker-compose.yml) so child processes are reaped.
ENTRYPOINT ["node", "/app/server/dist/main.js"]
CMD ["gateway"]
