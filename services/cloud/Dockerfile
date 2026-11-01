# Build context is the repository root (go.work needs all modules):
#   docker build -f services/cloud/Dockerfile -t memobrain-cloud .
# The Web UI is built first and embedded into the binary (services/cloud/web-embed). It includes the vault
# workbench (ADR-0029), which needs two things the repository does not hold: the Wails bindings the UI is
# typed against (generated from the Go code) and the desktop core compiled to WebAssembly.

# 1. The Wails bindings (packages/workbench/wailsjs): TypeScript generated from the Go API.
FROM --platform=$BUILDPLATFORM golang:1.27.3-alpine3.24@sha256:d200d2dd76b03a99b52651fd1325aff7dcd35422c35c01bac56571b0507f3deb AS bindings
RUN apk add --no-cache git bash ca-certificates
WORKDIR /src
COPY go.work go.work.sum ./
COPY shared/go/go.mod shared/go/go.sum shared/go/
COPY services/cloud/go.mod services/cloud/go.sum services/cloud/
COPY apps/desktop/go.mod apps/desktop/go.sum apps/desktop/
RUN cd apps/desktop && go mod download
COPY shared/ shared/
COPY apps/desktop/ apps/desktop/
COPY scripts/install-wails.sh scripts/install-wails.sh
RUN bash scripts/install-wails.sh
# main.go embeds the desktop frontend build; the generator only needs the directory to exist.
RUN mkdir -p apps/desktop/frontend/dist packages/workbench && touch apps/desktop/frontend/dist/index.html \
    && cd apps/desktop && /go/bin/wails generate module

# 2. The desktop core as WebAssembly (apps/desktop/cmd/memobrain-core), run in a Web Worker by the browser.
FROM --platform=$BUILDPLATFORM golang:1.27.3-alpine3.24@sha256:d200d2dd76b03a99b52651fd1325aff7dcd35422c35c01bac56571b0507f3deb AS wasm
WORKDIR /src
COPY go.work go.work.sum ./
COPY shared/go/go.mod shared/go/go.sum shared/go/
COPY services/cloud/go.mod services/cloud/go.sum services/cloud/
COPY apps/desktop/go.mod apps/desktop/go.sum apps/desktop/
RUN cd apps/desktop && go mod download
COPY shared/ shared/
COPY apps/desktop/ apps/desktop/
ARG VERSION=dev
RUN mkdir -p /out && cd apps/desktop \
    && GOOS=js GOARCH=wasm go build -trimpath -ldflags "-s -w -X main.Version=${VERSION}" -o /out/memobrain-core.wasm ./cmd/memobrain-core \
    && cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" /out/wasm_exec.js

# 3. The Web UI: the console and the vault workbench.
FROM --platform=$BUILDPLATFORM node:24.22.2-alpine3.24@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS web
WORKDIR /src
RUN corepack enable
COPY package.json yarn.lock .yarnrc.yml tsconfig.base.json ./
COPY web web
COPY packages packages
COPY --from=bindings /src/packages/workbench/wailsjs packages/workbench/wailsjs
COPY --from=wasm /out/ build/wasm/
# The admin console validates configuration profiles against the shared JSON Schema.
COPY api/config-profile.schema.json api/config-profile.schema.json
# yarn needs the manifest of every workspace to resolve the lockfile; only the web app is installed.
COPY apps/desktop/frontend/package.json apps/desktop/frontend/package.json
COPY shared/conformance/ts/package.json shared/conformance/ts/package.json
RUN yarn workspaces focus @memobrain/web
ARG VERSION=dev
RUN MEMOBRAIN_VERSION=${VERSION} yarn workspace @memobrain/web run build

# 4. The cloud binary, with the Web UI embedded. It runs on the build machine and cross-compiles for the
# target (CGO is off), so a multi-arch image needs no emulation: the Go compiler is the same speed for both.
FROM --platform=$BUILDPLATFORM golang:1.27.3-alpine3.24@sha256:d200d2dd76b03a99b52651fd1325aff7dcd35422c35c01bac56571b0507f3deb AS build
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
RUN apk add --no-cache git ca-certificates
COPY go.work go.work.sum ./
COPY shared/go/go.mod shared/go/go.sum shared/go/
COPY services/cloud/go.mod services/cloud/go.sum services/cloud/
COPY apps/desktop/go.mod apps/desktop/go.sum apps/desktop/
RUN cd services/cloud && go mod download
COPY shared/ shared/
COPY services/cloud/ services/cloud/
COPY --from=web /src/web/dist/ services/cloud/web-embed/dist/
COPY apps/desktop/go.mod apps/desktop/go.sum apps/desktop/
ARG VERSION=dev
RUN cd services/cloud && CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} go build -trimpath \
    -ldflags "-s -w -X main.Version=${VERSION}" -o /out/memobrain-cloud ./cmd/memobrain-cloud

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=build /out/memobrain-cloud /memobrain-cloud
USER nonroot:nonroot
# 18083: internal listener of --role=worker (/metrics, /healthz, /readyz).
EXPOSE 18081 18082 18083
ENV LISTEN_ADDR=0.0.0.0:18081 GRPC_LISTEN_ADDR=0.0.0.0:18082 METRICS_LISTEN_ADDR=0.0.0.0:18083
ENTRYPOINT ["/memobrain-cloud"]
CMD ["--role=all"]
