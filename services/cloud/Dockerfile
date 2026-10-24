# Build context is the repository root (go.work needs all modules):
#   docker build -f services/cloud/Dockerfile -t nodus-cloud .
# The Web UI is built first and embedded into the binary (services/cloud/web-embed).
FROM node:24-alpine AS web
WORKDIR /src
RUN corepack enable
COPY package.json yarn.lock .yarnrc.yml tsconfig.base.json ./
COPY .yarn .yarn
COPY web web
COPY packages packages
# The admin console validates configuration profiles against the shared JSON Schema.
COPY api/config-profile.schema.json api/config-profile.schema.json
# yarn needs the manifest of every workspace to resolve the lockfile; only the web app is installed.
COPY apps/desktop/frontend/package.json apps/desktop/frontend/package.json
COPY shared/conformance/ts/package.json shared/conformance/ts/package.json
RUN yarn workspaces focus @nodus/web
RUN yarn workspace @nodus/web run build

FROM golang:1.26-alpine AS build
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
RUN cd services/cloud && CGO_ENABLED=0 GOOS=linux go build -trimpath \
    -ldflags "-s -w -X main.Version=${VERSION}" -o /out/nodus-cloud ./cmd/nodus-cloud

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/nodus-cloud /nodus-cloud
USER nonroot:nonroot
EXPOSE 18081 18082
ENV LISTEN_ADDR=0.0.0.0:18081 GRPC_LISTEN_ADDR=0.0.0.0:18082
ENTRYPOINT ["/nodus-cloud"]
CMD ["--role=all"]
