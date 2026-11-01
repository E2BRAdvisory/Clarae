package config

import (
	"net/netip"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestParsePrefixes(t *testing.T) {
	got, err := parsePrefixes([]string{"10.0.0.0/8", "192.168.1.7/16", "203.0.113.9", "::ffff:198.51.100.1", "fd00::/8"})
	if err != nil {
		t.Fatal(err)
	}
	want := []netip.Prefix{
		netip.MustParsePrefix("10.0.0.0/8"),
		netip.MustParsePrefix("192.168.0.0/16"), // masked
		netip.MustParsePrefix("203.0.113.9/32"), // bare address: one host
		netip.MustParsePrefix("198.51.100.1/32"),
		netip.MustParsePrefix("fd00::/8"),
	}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	if _, err := parsePrefixes([]string{"10.0.0.0/8", "proxy.local"}); err == nil {
		t.Fatal("a host name was accepted")
	}
}

func TestLoadRejectsInvalidTrustedProxies(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x")
	t.Setenv("OIDC_ISSUER", "https://issuer")
	t.Setenv("STORAGE_DIR", t.TempDir())
	t.Setenv("TRUSTED_PROXIES", "10.0.0.0/8, nope")
	if _, err := Load(RoleAll, "test"); err == nil {
		t.Fatal("invalid TRUSTED_PROXIES accepted")
	}
	t.Setenv("TRUSTED_PROXIES", "10.0.0.0/8, 172.16.0.0/12")
	c, err := Load(RoleAll, "test")
	if err != nil || len(c.TrustedProxies) != 2 {
		t.Fatalf("got %v (%v)", c.TrustedProxies, err)
	}
}

// minimalEnv sets the variables Load requires, with real-looking secrets.
func minimalEnv(t *testing.T) {
	t.Helper()
	t.Setenv("DATABASE_URL", "postgres://memobrain:s3cr3t-Value@db:5432/memobrain?sslmode=require")
	t.Setenv("OIDC_ISSUER", "https://issuer")
	t.Setenv("S3_ENDPOINT", "http://s3:9000")
	t.Setenv("S3_ACCESS_KEY", "memobrain")
	t.Setenv("S3_SECRET_KEY", "memobrain-secret")
	t.Setenv("KC_ADMIN_CLIENT_SECRET", "dev-admin-svc-secret")
	t.Setenv("MEMOBRAIN_ALLOW_PLACEHOLDER_SECRETS", "")
}

func TestLoadRejectsPlaceholderSecrets(t *testing.T) {
	cases := map[string][2]string{
		"database url password":    {"DATABASE_URL", "postgres://memobrain:change-me@postgres:5432/memobrain?sslmode=require"},
		"database url query":       {"DATABASE_URL", "postgres://memobrain@postgres/memobrain?password=change-me"},
		"database keyword dsn":     {"DATABASE_URL", "host=postgres user=memobrain password='change-me' dbname=memobrain"},
		"s3 access key":            {"S3_ACCESS_KEY", "change-me"},
		"s3 secret key":            {"S3_SECRET_KEY", "change-me-too"},
		"keycloak client secret":   {"KC_ADMIN_CLIENT_SECRET", "change-me"},
		"case and spaces ignored":  {"KC_ADMIN_CLIENT_SECRET", " Change-Me "},
		"placeholder without dash": {"S3_SECRET_KEY", "changeme"},
	}
	for name, kv := range cases {
		t.Run(name, func(t *testing.T) {
			minimalEnv(t)
			t.Setenv(kv[0], kv[1])
			_, err := Load(RoleAll, "test")
			if err == nil || !strings.Contains(err.Error(), "placeholder") || !strings.Contains(err.Error(), kv[0]) {
				t.Fatalf("%s=%q: got %v, want a placeholder error naming %s", kv[0], kv[1], err, kv[0])
			}
			// The explicit escape hatch lets it start, and the setting is still reported.
			t.Setenv("MEMOBRAIN_ALLOW_PLACEHOLDER_SECRETS", "1")
			c, err := Load(RoleAll, "test")
			if err != nil {
				t.Fatalf("with MEMOBRAIN_ALLOW_PLACEHOLDER_SECRETS=1: %v", err)
			}
			if got := c.PlaceholderSecrets(); len(got) != 1 || !strings.HasPrefix(got[0], kv[0]) {
				t.Fatalf("PlaceholderSecrets() = %v", got)
			}
		})
	}
}

// The development and test setups (deploy/docker/cloud.dev.env, k3d, testcontainers) must keep starting.
func TestLoadAcceptsDevelopmentSecrets(t *testing.T) {
	minimalEnv(t)
	for _, dsn := range []string{
		"postgres://memobrain:memobrain@127.0.0.1:5433/memobrain?sslmode=disable",
		"postgres://memobrain:memobrain@postgres:5432/memobrain?sslmode=disable",
		"postgres://memobrain@127.0.0.1/memobrain", // no password at all
		"postgres://memobrain:change-me-not@db/memobrain",
	} {
		t.Setenv("DATABASE_URL", dsn)
		if _, err := Load(RoleAll, "test"); err != nil {
			t.Errorf("DATABASE_URL=%s: %v", dsn, err)
		}
	}
	t.Setenv("S3_ACCESS_KEY", "")
	t.Setenv("S3_SECRET_KEY", "")
	t.Setenv("KC_ADMIN_CLIENT_SECRET", "")
	if _, err := Load(RoleAll, "test"); err != nil {
		t.Errorf("empty optional secrets: %v", err)
	}
}

// Regression (W8): a malformed duration or boolean silently became the default
// (SHUTDOWN_TIMEOUT=30 ran with 15 s). Every bad value is reported, by name.
func TestLoadRejectsMalformedValues(t *testing.T) {
	minimalEnv(t)
	t.Setenv("SHUTDOWN_TIMEOUT", "30")
	t.Setenv("SHUTDOWN_DRAIN", "5 seconds")
	t.Setenv("S3_USE_PATH_STYLE", "yes")
	t.Setenv("OIDC_STATUS_CACHE_TTL", "30x")
	_, err := Load(RoleAll, "test")
	if err == nil {
		t.Fatal("malformed values accepted")
	}
	for _, name := range []string{"SHUTDOWN_TIMEOUT", "SHUTDOWN_DRAIN", "S3_USE_PATH_STYLE", "OIDC_STATUS_CACHE_TTL"} {
		if !strings.Contains(err.Error(), name) {
			t.Errorf("the error does not name %s: %v", name, err)
		}
	}
}

func TestLoadRejectsOutOfRangeDurations(t *testing.T) {
	for name, kv := range map[string][2]string{
		"zero shutdown timeout": {"SHUTDOWN_TIMEOUT", "0s"},
		"negative drain":        {"SHUTDOWN_DRAIN", "-1s"},
		"status cache too long": {"OIDC_STATUS_CACHE_TTL", "10m"},
		"negative status cache": {"OIDC_STATUS_CACHE_TTL", "-5s"},
	} {
		t.Run(name, func(t *testing.T) {
			minimalEnv(t)
			t.Setenv(kv[0], kv[1])
			if _, err := Load(RoleAll, "test"); err == nil || !strings.Contains(err.Error(), kv[0]) {
				t.Fatalf("%s=%s: got %v", kv[0], kv[1], err)
			}
		})
	}
}

func TestLoadAcceptsWellFormedValues(t *testing.T) {
	minimalEnv(t)
	t.Setenv("SHUTDOWN_TIMEOUT", "20s")
	t.Setenv("SHUTDOWN_DRAIN", "0s")
	t.Setenv("S3_USE_PATH_STYLE", "false")
	t.Setenv("OIDC_STATUS_CACHE_TTL", "0s")
	c, err := Load(RoleAll, "test")
	if err != nil {
		t.Fatal(err)
	}
	if c.ShutdownTimeout != 20*time.Second || c.ShutdownDrain != 0 || c.S3.UsePathStyle || c.OIDC.StatusCacheTTL != 0 {
		t.Fatalf("got %+v", c)
	}
}
