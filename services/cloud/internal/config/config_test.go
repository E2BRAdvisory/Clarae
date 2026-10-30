package config

import (
	"net/netip"
	"slices"
	"testing"
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
