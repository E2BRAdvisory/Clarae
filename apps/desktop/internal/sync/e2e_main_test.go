//go:build integration

package sync_test

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
)

// The end-to-end tests run the real cloud service (the nodus-cloud binary,
// built from this repository) against PostgreSQL in a container, with a local
// OIDC issuer standing in for Keycloak. Two desktop engines then synchronize
// through it, exactly as two devices would.

var (
	serverURL   string
	databaseURL string
	issuer      *testIssuer
)

func TestMain(m *testing.M) { os.Exit(run(m)) }

func run(m *testing.M) int {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	pg, err := tcpostgres.Run(ctx, "postgres:17",
		tcpostgres.WithDatabase("nodus"), tcpostgres.WithUsername("nodus"), tcpostgres.WithPassword("nodus"),
		testcontainers.WithWaitStrategy(wait.ForLog("database system is ready to accept connections").WithOccurrence(2).WithStartupTimeout(60*time.Second)),
	)
	if err != nil {
		log.Printf("start postgres: %v", err)
		return 1
	}
	defer func() { _ = pg.Terminate(context.Background()) }()
	databaseURL, err = pg.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		log.Print(err)
		return 1
	}

	issuer = newIssuer()
	defer issuer.srv.Close()

	tmp, err := os.MkdirTemp("", "nodus-e2e-")
	if err != nil {
		log.Print(err)
		return 1
	}
	defer func() { _ = os.RemoveAll(tmp) }()

	bin := filepath.Join(tmp, "nodus-cloud")
	build := exec.CommandContext(ctx, "go", "build", "-o", bin, "nodus/services/cloud/cmd/nodus-cloud")
	build.Stderr, build.Stdout = os.Stderr, os.Stdout
	if err := build.Run(); err != nil {
		log.Printf("build cloud service: %v", err)
		return 1
	}

	httpAddr, grpcAddr := freeAddr(), freeAddr()
	srv := exec.Command(bin, "--role=all")
	srv.Env = append(os.Environ(),
		"LISTEN_ADDR="+httpAddr, "GRPC_LISTEN_ADDR="+grpcAddr, "DATABASE_URL="+databaseURL,
		"STORAGE_DIR="+filepath.Join(tmp, "blobs"), "OIDC_ISSUER="+issuer.srv.URL, "OIDC_AUDIENCE=nodus-api",
		"OIDC_STATUS_CACHE_TTL=1s", "LOG_LEVEL=warn",
	)
	logFile, _ := os.Create(filepath.Join(tmp, "cloud.log"))
	srv.Stdout, srv.Stderr = logFile, logFile
	if err := srv.Start(); err != nil {
		log.Printf("start cloud service: %v", err)
		return 1
	}
	defer func() { _ = srv.Process.Kill(); _, _ = srv.Process.Wait() }()
	serverURL = "http://" + httpAddr
	if err := waitReady(serverURL + "/api/v1/readyz"); err != nil {
		b, _ := os.ReadFile(logFile.Name())
		log.Printf("cloud service not ready: %v\n%s", err, b)
		return 1
	}
	code := m.Run()
	if code != 0 {
		b, _ := os.ReadFile(logFile.Name())
		if len(b) > 0 {
			log.Printf("cloud service log:\n%s", b)
		}
	}
	return code
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
		if resp, err := http.Get(url); err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	return fmt.Errorf("timeout waiting for %s", url)
}

// testIssuer is a minimal OIDC provider: discovery, JWKS and token signing.
type testIssuer struct {
	srv    *httptest.Server
	signer jose.Signer
}

func newIssuer() *testIssuer {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		panic(err)
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: key}, (&jose.SignerOptions{}).WithType("JWT").WithHeader("kid", "e2e"))
	if err != nil {
		panic(err)
	}
	iss := &testIssuer{signer: signer}
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
	iss.srv = httptest.NewServer(mux)
	return iss
}

func (i *testIssuer) token(user string) string {
	now := time.Now()
	claims := jwt.Claims{Issuer: i.srv.URL, Subject: "e2e-" + user, Audience: jwt.Audience{"nodus-api"}, IssuedAt: jwt.NewNumericDate(now), NotBefore: jwt.NewNumericDate(now.Add(-time.Minute)), Expiry: jwt.NewNumericDate(now.Add(time.Hour))}
	private := map[string]any{"typ": "Bearer", "azp": "nodus-desktop", "preferred_username": user, "email": user + "@e2e.local", "realm_access": map[string]any{"roles": []string{"nodus-user"}}}
	raw, err := jwt.Signed(i.signer).Claims(claims).Claims(private).Serialize()
	if err != nil {
		panic(err)
	}
	return raw
}

func openDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}
