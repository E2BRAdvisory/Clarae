//go:build integration

// Package cloudtest runs the real cloud service for the desktop integration
// tests: the memobrain-cloud binary, built from this repository, against
// PostgreSQL in a container, with a local OIDC issuer standing in for
// Keycloak. Packages call Start from TestMain and share the Env.
package cloudtest

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
)

// Env is a running cloud service.
type Env struct {
	// ServerURL is the base URL of the service (scheme and host, no /api/v1).
	ServerURL string
	// DatabaseURL connects to its PostgreSQL database.
	DatabaseURL string
	// Issuer signs the access tokens the service accepts.
	Issuer *Issuer

	logPath string
	cleanup []func()
}

// Start builds and starts the service; the caller must call Stop.
func Start(ctx context.Context) (*Env, error) {
	e := &Env{}
	ok := false
	defer func() {
		if !ok {
			e.Stop()
		}
	}()

	pg, err := tcpostgres.Run(ctx, "postgres:17",
		tcpostgres.WithDatabase("memobrain"), tcpostgres.WithUsername("memobrain"), tcpostgres.WithPassword("memobrain"),
		testcontainers.WithWaitStrategy(wait.ForLog("database system is ready to accept connections").WithOccurrence(2).WithStartupTimeout(60*time.Second)),
	)
	if err != nil {
		return nil, fmt.Errorf("start postgres: %w", err)
	}
	e.cleanup = append(e.cleanup, func() { _ = pg.Terminate(context.Background()) })
	if e.DatabaseURL, err = pg.ConnectionString(ctx, "sslmode=disable"); err != nil {
		return nil, err
	}

	e.Issuer = newIssuer()
	e.cleanup = append(e.cleanup, e.Issuer.srv.Close)

	tmp, err := os.MkdirTemp("", "memobrain-e2e-")
	if err != nil {
		return nil, err
	}
	e.cleanup = append(e.cleanup, func() { _ = os.RemoveAll(tmp) })

	bin := filepath.Join(tmp, "memobrain-cloud")
	build := exec.CommandContext(ctx, "go", "build", "-o", bin, "memobrain/services/cloud/cmd/memobrain-cloud") //nolint:gosec // test harness: fixed command, temp output path
	build.Stderr, build.Stdout = os.Stderr, os.Stdout
	if err := build.Run(); err != nil {
		return nil, fmt.Errorf("build cloud service: %w", err)
	}

	httpAddr, grpcAddr := freeAddr(), freeAddr()
	srv := exec.Command(bin, "--role=all") //nolint:gosec // test harness: the binary it just built
	srv.Env = append(os.Environ(),
		"LISTEN_ADDR="+httpAddr, "GRPC_LISTEN_ADDR="+grpcAddr, "DATABASE_URL="+e.DatabaseURL,
		"STORAGE_DIR="+filepath.Join(tmp, "blobs"), "OIDC_ISSUER="+e.Issuer.srv.URL, "OIDC_AUDIENCE=memobrain-api",
		"OIDC_STATUS_CACHE_TTL=1s", "LOG_LEVEL=warn",
	)
	e.logPath = filepath.Join(tmp, "cloud.log")
	logFile, err := os.Create(e.logPath)
	if err != nil {
		return nil, err
	}
	srv.Stdout, srv.Stderr = logFile, logFile
	if err := srv.Start(); err != nil {
		return nil, fmt.Errorf("start cloud service: %w", err)
	}
	e.cleanup = append(e.cleanup, func() { _ = srv.Process.Kill(); _, _ = srv.Process.Wait(); _ = logFile.Close() })
	e.ServerURL = "http://" + httpAddr
	if err := waitReady(e.ServerURL + "/api/v1/readyz"); err != nil {
		return nil, fmt.Errorf("cloud service not ready: %w\n%s", err, e.Log())
	}
	ok = true
	return e, nil
}

// Stop shuts everything down, in reverse order of start.
func (e *Env) Stop() {
	for i := len(e.cleanup) - 1; i >= 0; i-- {
		e.cleanup[i]()
	}
	e.cleanup = nil
}

// Log returns what the service logged so far.
func (e *Env) Log() []byte {
	if e.logPath == "" {
		return nil
	}
	b, _ := os.ReadFile(e.logPath)
	return b
}

func freeAddr() string {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		panic(err)
	}
	defer func() { _ = l.Close() }()
	return l.Addr().String()
}

func waitReady(url string) error {
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		if resp, err := http.Get(url); err == nil { //nolint:gosec // test harness: local readiness probe
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	return errors.New("timeout waiting for " + url)
}

// Issuer is a minimal OIDC provider: discovery, JWKS and token signing.
type Issuer struct {
	srv    *httptest.Server
	signer jose.Signer
}

func newIssuer() *Issuer {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		panic(err)
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: key}, (&jose.SignerOptions{}).WithType("JWT").WithHeader("kid", "e2e"))
	if err != nil {
		panic(err)
	}
	iss := &Issuer{signer: signer}
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"issuer": iss.srv.URL, "jwks_uri": iss.srv.URL + "/jwks", "authorization_endpoint": iss.srv.URL + "/auth",
			"token_endpoint": iss.srv.URL + "/token", "id_token_signing_alg_values_supported": []string{"RS256"},
		})
	})
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &key.PublicKey, KeyID: "e2e", Algorithm: "RS256", Use: "sig"}}})
	})
	// The handlers read iss.srv: publish it before the server starts serving.
	iss.srv = httptest.NewUnstartedServer(mux)
	iss.srv.Start()
	return iss
}

// URL is the issuer URL.
func (i *Issuer) URL() string { return i.srv.URL }

// Token returns a valid access token for user (provisioned on first use).
func (i *Issuer) Token(user string) string {
	now := time.Now()
	claims := jwt.Claims{Issuer: i.srv.URL, Subject: "e2e-" + user, Audience: jwt.Audience{"memobrain-api"}, IssuedAt: jwt.NewNumericDate(now), NotBefore: jwt.NewNumericDate(now.Add(-time.Minute)), Expiry: jwt.NewNumericDate(now.Add(time.Hour))}
	private := map[string]any{"typ": "Bearer", "azp": "memobrain-desktop", "preferred_username": user, "email": user + "@e2e.local", "realm_access": map[string]any{"roles": []string{"memobrain-user"}}}
	raw, err := jwt.Signed(i.signer).Claims(claims).Claims(private).Serialize()
	if err != nil {
		panic(err)
	}
	return raw
}
