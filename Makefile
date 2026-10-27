# Nodus monorepo entry points. Run `make help` for the list.
SHELL := /bin/bash
.DEFAULT_GOAL := help

GO_MODULES := shared/go services/cloud apps/desktop
CLOUD      := services/cloud
WEB        := web
WEBEMBED   := $(CLOUD)/web-embed
DESKTOP    := apps/desktop
COMPOSE    := docker compose -f deploy/docker/compose.dev.yaml

## ---- tooling ---------------------------------------------------------------

.PHONY: tools
tools: ## Install pinned developer tools from tools/go.mod (into GOBIN) and JS deps
	cd tools && GOWORK=off go install tool
	yarn install --immutable

## ---- code generation -------------------------------------------------------

.PHONY: gen gen-openapi gen-proto gen-sqlc gen-wails
gen: gen-openapi gen-proto gen-sqlc gen-wails ## Regenerate all generated code

gen-openapi: ## OpenAPI -> Go server stubs + TS client
	@test -f api/openapi.yaml || { echo "api/openapi.yaml missing (M0-WP2)"; exit 0; }
	cd $(CLOUD) && oapi-codegen -config ../../api/oapi-codegen.yaml ../../api/openapi.yaml
	@if [ -d packages/api-client ]; then yarn workspace @nodus/api-client run gen; fi

gen-proto: ## protobuf -> Go (buf)
	@test -f api/proto/buf.yaml || { echo "api/proto/buf.yaml missing (M0-WP2)"; exit 0; }
	cd api/proto && buf generate

gen-sqlc: ## SQL queries -> typed Go (sqlc)
	@test -f $(CLOUD)/sqlc.yaml || { echo "$(CLOUD)/sqlc.yaml missing (M0-WP3)"; exit 0; }
	cd $(CLOUD) && sqlc generate

gen-wails: ## Wails Go bindings -> frontend/wailsjs
	cd $(DESKTOP) && wails generate module

## ---- quality ---------------------------------------------------------------

.PHONY: lint lint-go lint-ts
lint: lint-go lint-ts ## Lint everything

lint-go: ## golangci-lint on all Go modules
	@for m in $(GO_MODULES); do echo "==> $$m"; (cd $$m && golangci-lint run ./...) || exit 1; done

lint-ts: ## ESLint + Prettier
	yarn run lint

.PHONY: vuln
vuln: ## govulncheck on all Go modules
	@for m in $(GO_MODULES); do echo "==> $$m"; (cd $$m && govulncheck ./...) || exit 1; done

.PHONY: test test-go test-ts test-integration conformance
test: test-go test-ts conformance ## Unit tests (Go + TS) and conformance suite

test-go: ## go test -race on all Go modules
	@for m in $(GO_MODULES); do echo "==> $$m"; (cd $$m && go test -race -count=1 ./...) || exit 1; done

test-ts: ## Vitest in every workspace package
	yarn run test

test-integration: ## Cloud integration tests (testcontainers: PG, MinIO, Keycloak)
	cd $(CLOUD) && go test -race -count=1 -tags integration ./test/...

conformance: ## Shared Markdown/merge/crypto fixtures run by Go and TS
	cd shared/go && go test -race -count=1 -run Conformance ./conformance/...
	@if [ -d $(DESKTOP)/internal/parser ]; then cd $(DESKTOP) && go test -race -count=1 -run Conformance ./internal/parser/...; fi
	yarn workspace @nodus/conformance run test
	yarn workspace @nodus/markdown run test
	@if [ -f $(DESKTOP)/frontend/src/test/conformance.test.ts ]; then yarn workspace @nodus/desktop-frontend exec vitest run src/test/conformance.test.ts; fi

.PHONY: test-desktop-e2e test-load
test-desktop-e2e: ## Two-device sync e2e (builds the cloud binary, PG via testcontainers)
	cd $(DESKTOP) && go test -race -count=1 -tags integration ./internal/sync/...

test-load: ## k6 load test (needs a running `make dev-cloud`; see services/cloud/test/load/README.md)
	k6 run $(CLOUD)/test/load/sync.k6.js

.PHONY: e2e e2e-desktop e2e-web
e2e: e2e-desktop e2e-web ## Playwright (Chromium) for the desktop UI and the Web UI

e2e-desktop: ## Desktop UI against the in-memory Wails mock
	yarn workspace @nodus/desktop-frontend run e2e

e2e-web: ## Web UI on the Vite dev server with the API mocked (OIDC test double)
	yarn workspace @nodus/web run e2e

.PHONY: ci
ci: lint vuln test ## What CI runs on every push

## ---- run -------------------------------------------------------------------

.PHONY: stack-up stack-down stack-logs
stack-up: ## Start PostgreSQL, MinIO and Keycloak for development
	$(COMPOSE) up -d --wait

stack-down: ## Stop the development stack (keeps volumes)
	$(COMPOSE) down

stack-logs: ## Tail the development stack logs
	$(COMPOSE) logs -f

stack-reset: ## Destroy the stack volumes (re-imports the Keycloak realm, empties PG and S3) and start again
	$(COMPOSE) down -v
	$(COMPOSE) up -d --wait

.PHONY: dev-cloud dev-desktop dev-web
dev-cloud: ## Run the cloud service against the local stack (role=all)
	cd $(CLOUD) && set -a && source ../../deploy/docker/cloud.dev.env && set +a && go run ./cmd/nodus-cloud --role=all

dev-desktop: ## Run the desktop app with hot reload
	cd $(DESKTOP) && wails dev

dev-web: ## Web UI on :5174 with hot reload, proxying /api to the cloud on :18081
	yarn workspace @nodus/web run dev

.PHONY: run-desktop run-desktop-cloud run-desktop-2devices dev-stop
run-desktop: ## Desktop standalone (no cloud) with a demo vault: scripts/run-desktop.sh --demo
	scripts/run-desktop.sh --demo

run-desktop-cloud: ## Desktop + Docker stack + cloud service: scripts/run-desktop-with-cloud.sh --demo
	scripts/run-desktop-with-cloud.sh --demo

run-desktop-2devices: ## Two desktop instances against the cloud (simulates two devices)
	scripts/run-desktop-with-cloud.sh --two-devices --demo

dev-stop: ## Stop the cloud process started by the run scripts (add ARGS=--stack or --purge)
	scripts/dev-stop.sh $(ARGS)

## ---- build -----------------------------------------------------------------

VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)

.PHONY: web-build web-clean build-cloud build-desktop
web-build: ## Build the Web UI and copy it into the cloud binary's embed dir (then run build-cloud)
	yarn workspace @nodus/web run build
	rm -rf $(WEBEMBED)/dist && mkdir -p $(WEBEMBED)/dist
	cp -R $(WEB)/dist/. $(WEBEMBED)/dist/

web-clean: ## Drop the embedded Web UI build and restore the tracked placeholder index.html
	rm -rf $(WEBEMBED)/dist && mkdir -p $(WEBEMBED)/dist
	git checkout -- $(WEBEMBED)/dist/index.html

build-cloud: ## Build the cloud binary into bin/ (embeds whatever is in web-embed/dist: run web-build first)
	cd $(CLOUD) && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.Version=$(VERSION)" -o ../../bin/nodus-cloud ./cmd/nodus-cloud

build-desktop: ## Build the desktop app for the current OS
	cd $(DESKTOP) && wails build -clean -ldflags "-X main.Version=$(VERSION)"

## ---- release / distribution (M7-WP3, docs/release/README.md) --------------

.PHONY: release-tool helm-check release-desktop
release-tool: ## Build tools/release (gen-manifest, sign-manifest, verify-manifest) into bin/release
	cd tools/release && GOWORK=off go build -o ../../bin/release .

helm-check: ## helm lint + template for the chart with every values file
	helm lint deploy/helm/nodus
	@for f in deploy/helm/nodus/values-k3d.yaml deploy/helm/nodus/ci/*.yaml; do helm lint deploy/helm/nodus -f $$f >/dev/null && helm template ci deploy/helm/nodus -f $$f >/dev/null && echo "ok $$f" || exit 1; done

release-desktop: ## Local installer build: make release-desktop OS=darwin|windows|linux V=1.0.0-rc.1
	bash scripts/release/build-desktop.sh $(OS) $(V)

## ---- maintenance -----------------------------------------------------------

.PHONY: rename-module
rename-module: ## Rename the Go module path placeholder: make rename-module NEW=github.com/org/nodus
	@test -n "$(NEW)" || { echo "usage: make rename-module NEW=github.com/org/nodus"; exit 1; }
	@git ls-files -z -- '*.go' 'go.mod' 'go.work' '*.yaml' '*.yml' '*.md' 'Makefile' \
		| xargs -0 perl -pi -e 's{(?<![\w./-])nodus/(apps|services|shared)\b}{$(NEW)/$$1}g'
	@echo "Module paths renamed to $(NEW)/...; run: go work sync && make gen"

## ---- performance (M7-WP1; see docs/perf/README.md) ------------------------

PERF_NOTES ?= 50000
PERF_DIR   ?= $(CURDIR)/.perf
PERF_OUT   ?= $(PERF_DIR)/results-$(PERF_NOTES).json

.PHONY: perf perf-data perf-check perf-load-env
perf-data: ## Generate the synthetic vault (cached): make perf-data PERF_NOTES=50000
	cd $(DESKTOP) && go run ./internal/perf/cmd/perfdata -notes $(PERF_NOTES) -dir $(PERF_DIR)/vault-$(PERF_NOTES)

perf: ## Desktop perf suite (index, search, note open, vault open, graph 10k): make perf PERF_NOTES=50000
	@mkdir -p $(PERF_DIR)
	cd $(DESKTOP) && NODUS_PERF_NOTES=$(PERF_NOTES) NODUS_PERF_DIR=$(PERF_DIR) NODUS_PERF_OUT=$(PERF_OUT) \
		go test -run TestPerf -count=1 -timeout 90m -v ./internal/perf/

perf-check: ## Fail on regressions vs the stored baseline: make perf-check PERF_NOTES=50000 [PERF_TOLERANCE=25]
	cd $(DESKTOP) && go run ./internal/perf/cmd/perfcheck -baseline ../../docs/perf/baseline-$(PERF_NOTES).json \
		-results $(PERF_OUT) -tolerance $(or $(PERF_TOLERANCE),25)

perf-load-env: ## Cloud load env for k6 (needs Docker): make perf-load-env USERS=1000, then k6 run -e TOKENS=.perf/tokens.json services/cloud/test/load/k6/active-users.js
	@mkdir -p $(PERF_DIR)
	cd $(CLOUD) && NODUS_LOADENV_USERS=$(or $(USERS),1000) NODUS_LOADENV_OUT=$(PERF_DIR)/tokens.json \
		go test -tags integration -run TestServeLoadEnv -count=1 -timeout 2h -v ./test/integration/

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'
