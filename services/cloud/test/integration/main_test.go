//go:build integration

// Package integration runs the cloud service against real dependencies
// (PostgreSQL in a container, an in-process OIDC issuer) and validates every
// response against api/openapi.yaml.
package integration

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/getkin/kin-openapi/openapi3filter"
	"github.com/getkin/kin-openapi/routers"
	"github.com/getkin/kin-openapi/routers/gorillamux"
	"github.com/rs/zerolog"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"clarae/services/cloud/internal/app"
	"clarae/services/cloud/internal/auth"
	"clarae/services/cloud/internal/auth/authtest"
	"clarae/services/cloud/internal/db"
	"clarae/services/cloud/internal/httpserver"
	"clarae/services/cloud/internal/storage"
	"clarae/services/cloud/internal/system"
)

var (
	databaseURL string
	specRouter  routers.Router
)

// postgresImage is the PostgreSQL the tests run against: the version and
// digest the deployment pins (deploy/PINS.md), refreshed together with them.
const postgresImage = "postgres:17.11@sha256:3b0cda93be7c8dba2ed484d19393d93845dc3dafb88973e248ba8e6d99d784e1"

func TestMain(m *testing.M) {
	os.Exit(run(m))
}

func run(m *testing.M) int {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	pg, err := tcpostgres.Run(ctx, postgresImage,
		tcpostgres.WithDatabase("clarae"),
		tcpostgres.WithUsername("clarae"),
		tcpostgres.WithPassword("clarae"),
		testcontainers.WithWaitStrategy(wait.ForLog("database system is ready to accept connections").WithOccurrence(2).WithStartupTimeout(60*time.Second)),
	)
	if err != nil {
		log.Printf("start postgres: %v", err)
		return 1
	}
	defer func() { _ = pg.Terminate(context.Background()) }()

	databaseURL, err = pg.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		log.Printf("connection string: %v", err)
		return 1
	}
	specRouter, err = loadSpecRouter()
	if err != nil {
		log.Printf("openapi: %v", err)
		return 1
	}
	return m.Run()
}

func loadSpecRouter() (routers.Router, error) {
	root, err := repoRoot()
	if err != nil {
		return nil, err
	}
	loader := openapi3.NewLoader()
	doc, err := loader.LoadFromFile(filepath.Join(root, "api", "openapi.yaml"))
	if err != nil {
		return nil, err
	}
	if err := doc.Validate(loader.Context); err != nil {
		return nil, fmt.Errorf("spec invalid: %w", err)
	}
	// Server URL in the spec is the relative "/api/v1"; the router matches on path.
	return gorillamux.NewRouter(doc)
}

func repoRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.work")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("go.work not found above %s", dir)
		}
		dir = parent
	}
}

// env is one fully wired API instance backed by the shared database.
type env struct {
	t       *testing.T
	issuer  *authtest.Issuer
	authn   *auth.Middleware
	app     *app.App
	db      *db.DB
	server  *httptest.Server
	baseURL string
	kc      *fakeKeycloak
}

func newEnv(t *testing.T) *env {
	t.Helper()
	ctx := context.Background()
	database, err := db.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(database.Close)
	if err := database.Migrate(ctx); err != nil {
		t.Fatal(err)
	}

	issuer := authtest.New(t)
	verifier, err := auth.NewVerifier(ctx, issuer.URL(), "clarae-api", []string{"clarae-desktop", "clarae-web"})
	if err != nil {
		t.Fatal(err)
	}
	store, err := storage.NewFS(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	application := app.New(database, store, zerolog.Nop())
	kc := newFakeKeycloak()
	application.Keycloak = kc
	authn := auth.NewMiddleware(verifier, application.Users, nil, 30*time.Second)
	hubCtx, stopHub := context.WithCancel(ctx)
	t.Cleanup(stopHub)
	go func() { _ = application.Hub.Run(hubCtx) }()
	router := httpserver.NewRouter(application.FillDeps(httpserver.Deps{
		Logger: zerolog.Nop(),
		Auth:   authn,
		System: system.NewHTTP("test", system.ClientConfig{Issuer: issuer.URL(), DesktopClientID: "clarae-desktop", Audience: "clarae-api", GRPCEndpoint: "127.0.0.1:18082"}, system.CheckerFunc{N: "database", F: database.Ping}, system.CheckerFunc{N: "storage", F: store.Ping}),
	}))
	srv := httptest.NewServer(router)
	t.Cleanup(srv.Close)
	return &env{t: t, issuer: issuer, authn: authn, app: application, db: database, server: srv, baseURL: srv.URL + httpserver.BasePath, kc: kc}
}

// do performs a request and validates request and response against the spec.
func (e *env) do(req *http.Request) *http.Response {
	e.t.Helper()
	route, pathParams, err := specRouter.FindRoute(req)
	if err != nil {
		e.t.Fatalf("route %s %s not in spec: %v", req.Method, req.URL.Path, err)
	}
	input := &openapi3filter.RequestValidationInput{
		Request:    req,
		PathParams: pathParams,
		Route:      route,
		Options:    &openapi3filter.Options{AuthenticationFunc: openapi3filter.NoopAuthenticationFunc},
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	body := readAll(e.t, resp)
	err = openapi3filter.ValidateResponse(req.Context(), &openapi3filter.ResponseValidationInput{
		RequestValidationInput: input,
		Status:                 resp.StatusCode,
		Header:                 resp.Header,
		Body:                   body,
		Options:                &openapi3filter.Options{IncludeResponseStatus: true},
	})
	if err != nil {
		e.t.Fatalf("%s %s -> %d: response violates spec: %v", req.Method, req.URL.Path, resp.StatusCode, err)
	}
	return resp
}
