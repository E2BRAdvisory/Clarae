//go:build integration

package sync_test

import (
	"context"
	"log"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"clarae/apps/desktop/internal/cloudtest"
)

// The end-to-end tests run the real cloud service (the clarae-cloud binary,
// built from this repository) against PostgreSQL in a container, with a local
// OIDC issuer standing in for Keycloak (see cloudtest). Two desktop engines then
// synchronize through it, exactly as two devices would.

var (
	serverURL   string
	databaseURL string
	issuer      *cloudtest.Issuer
)

func TestMain(m *testing.M) { os.Exit(run(m)) }

func run(m *testing.M) int {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	env, err := cloudtest.Start(ctx)
	if err != nil {
		log.Print(err)
		return 1
	}
	defer env.Stop()
	serverURL, databaseURL, issuer = env.ServerURL, env.DatabaseURL, env.Issuer
	code := m.Run()
	if code != 0 {
		if b := env.Log(); len(b) > 0 {
			log.Printf("cloud service log:\n%s", b)
		}
	}
	return code
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
