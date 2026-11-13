package config

import (
	"strconv"
	"strings"
	"testing"

	"clarae/services/cloud/internal/auth"
)

// clearNames empties every variable that overrides a name default, so the test sees the defaults.
func clearNames(t *testing.T) {
	t.Helper()
	for _, k := range []string{
		"OIDC_AUDIENCE", "OIDC_ALLOWED_AZP", "OIDC_ADMIN_ROLES", "OIDC_DESKTOP_CLIENT_ID", "OIDC_WEB_CLIENT_ID",
		"KC_REALM", "KC_ADMIN_CLIENT_ID", "S3_BUCKET_BLOBS", "S3_BUCKET_EXPORTS", "METRICS_NAMESPACE",
		"CLARAE_ALLOW_PLACEHOLDER_SECRETS", "MEMOBRAIN_ALLOW_PLACEHOLDER_SECRETS",
	} {
		t.Setenv(k, "")
	}
}

// The compatibility matrix of the rebrand (ADR-0052, M17 B1): the names follow the realm of the
// installation. A realm made for 1.x keeps the audience, clients, buckets and metrics of 1.x, so
// the clients of 1.4.0 and the stored blobs keep working; any other issuer gets the new names.
func TestNameDefaultsFollowTheIssuer(t *testing.T) {
	for _, tc := range []struct {
		name, issuer string
		legacy       bool
		realm, fam   string
	}{
		{"1.x realm", "https://auth.example.com/realms/memobrain", true, "memobrain", "memobrain"},
		{"1.x realm, trailing slash", "https://auth.example.com/realms/memobrain/", true, "memobrain", "memobrain"},
		{"1.x realm behind a path prefix", "https://example.com/auth/realms/memobrain", true, "memobrain", "memobrain"},
		{"new realm", "https://auth.example.com/realms/clarae", false, "clarae", "clarae"},
		{"another realm", "https://auth.example.com/realms/acme", false, "acme", "clarae"},
		{"a realm that only starts like the old one", "https://auth.example.com/realms/memobrain-staging", false, "memobrain-staging", "clarae"},
		{"issuer without a realm", "https://issuer", false, "clarae", "clarae"},
		{"no issuer (worker)", "", false, "clarae", "clarae"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			minimalEnv(t)
			clearNames(t)
			t.Setenv("OIDC_ISSUER", tc.issuer)
			role := RoleAll
			if tc.issuer == "" {
				role = RoleWorker
			}
			c, err := Load(role, "test")
			if err != nil {
				t.Fatal(err)
			}
			f := tc.fam
			if c.LegacyNames != tc.legacy {
				t.Errorf("LegacyNames = %v, want %v", c.LegacyNames, tc.legacy)
			}
			want := map[string][2]string{
				"audience":        {c.OIDC.Audience, f + "-api"},
				"azp":             {strings.Join(c.OIDC.AllowedAZP, ","), f + "-desktop," + f + "-web"},
				"desktop client":  {c.OIDC.DesktopClientID, f + "-desktop"},
				"web client":      {c.OIDC.WebClientID, f + "-web"},
				"admin client":    {c.Keycloak.ClientID, f + "-admin-svc"},
				"realm":           {c.Keycloak.Realm, tc.realm},
				"blobs bucket":    {c.S3.BucketBlobs, f + "-blobs"},
				"exports bucket":  {c.S3.BucketExports, f + "-exports"},
				"metrics":         {c.MetricsNamespace, f},
				"admin roles":     {strings.Join(c.OIDC.AdminRoles, ","), "clarae-admin,memobrain-admin"},
				"blobs defaulted": {strconv.FormatBool(c.S3.BucketBlobsDefaulted), "true"},
			}
			for k, v := range want {
				if v[0] != v[1] {
					t.Errorf("%s = %q, want %q", k, v[0], v[1])
				}
			}
		})
	}
}

func TestExplicitNamesWinOverTheIssuerFamily(t *testing.T) {
	minimalEnv(t)
	clearNames(t)
	t.Setenv("OIDC_ISSUER", "https://auth.example.com/realms/memobrain")
	t.Setenv("OIDC_AUDIENCE", "clarae-api")
	t.Setenv("OIDC_ALLOWED_AZP", "clarae-desktop, clarae-web ,memobrain-desktop")
	t.Setenv("OIDC_DESKTOP_CLIENT_ID", "clarae-desktop")
	t.Setenv("OIDC_WEB_CLIENT_ID", "clarae-web")
	t.Setenv("KC_REALM", "other")
	t.Setenv("KC_ADMIN_CLIENT_ID", "svc")
	t.Setenv("S3_BUCKET_BLOBS", "my-blobs")
	t.Setenv("S3_BUCKET_EXPORTS", "my-exports")
	t.Setenv("OIDC_ADMIN_ROLES", "ops,root")
	t.Setenv("METRICS_NAMESPACE", "custom_ns")
	c, err := Load(RoleAll, "test")
	if err != nil {
		t.Fatal(err)
	}
	if c.OIDC.Audience != "clarae-api" || c.OIDC.DesktopClientID != "clarae-desktop" || c.OIDC.WebClientID != "clarae-web" ||
		c.Keycloak.Realm != "other" || c.Keycloak.ClientID != "svc" || c.S3.BucketBlobs != "my-blobs" || c.S3.BucketExports != "my-exports" {
		t.Fatalf("an explicit name lost against the default of the issuer: %+v", c)
	}
	if got := strings.Join(c.OIDC.AllowedAZP, "|"); got != "clarae-desktop|clarae-web|memobrain-desktop" {
		t.Fatalf("AllowedAZP = %s", got)
	}
	if got := strings.Join(c.OIDC.AdminRoles, "|"); got != "ops|root" {
		t.Fatalf("AdminRoles = %s", got)
	}
	if c.MetricsNamespace != "custom_ns" || MetricsNamespaceFromEnv() != "custom_ns" {
		t.Fatalf("metrics namespace %q / %q", c.MetricsNamespace, MetricsNamespaceFromEnv())
	}
	// Explicit buckets are never compared with the 1.x ones: the operator decided.
	if c.S3.BucketBlobsDefaulted || c.S3.BucketExportsDefaulted || c.S3.LegacyBucketBlobs != "" || c.S3.LegacyBucketExports != "" {
		t.Fatalf("explicit buckets flagged as defaults: %+v", c.S3)
	}
}

// The check that refuses to start on a missing default bucket needs to know the 1.x name, only
// when the bucket is a default that differs from it.
func TestLegacyBucketNamesAreOnlyForNewDefaults(t *testing.T) {
	minimalEnv(t)
	clearNames(t)

	t.Setenv("OIDC_ISSUER", "https://auth.example.com/realms/clarae")
	c, err := Load(RoleAll, "test")
	if err != nil {
		t.Fatal(err)
	}
	if !c.S3.BucketBlobsDefaulted || c.S3.LegacyBucketBlobs != "memobrain-blobs" || c.S3.LegacyBucketExports != "memobrain-exports" {
		t.Fatalf("new realm, default buckets: %+v", c.S3)
	}

	// On the 1.x realm the default already is the 1.x bucket: nothing to compare.
	t.Setenv("OIDC_ISSUER", "https://auth.example.com/realms/memobrain")
	if c, err = Load(RoleAll, "test"); err != nil || c.S3.LegacyBucketBlobs != "" || c.S3.BucketBlobs != "memobrain-blobs" {
		t.Fatalf("1.x realm: %+v (%v)", c.S3, err)
	}

	// An explicit S3_BUCKET_BLOBS (even with the default value) is the operator's decision.
	t.Setenv("OIDC_ISSUER", "https://auth.example.com/realms/clarae")
	t.Setenv("S3_BUCKET_BLOBS", "clarae-blobs")
	if c, err = Load(RoleAll, "test"); err != nil || c.S3.BucketBlobsDefaulted || c.S3.LegacyBucketBlobs != "" {
		t.Fatalf("explicit bucket: %+v (%v)", c.S3, err)
	}
}

func TestLoadRejectsAnInvalidMetricsNamespaceAndEmptyAdminRoles(t *testing.T) {
	for name, kv := range map[string][2]string{
		"uppercase":      {"METRICS_NAMESPACE", "Clarae"},
		"dash":           {"METRICS_NAMESPACE", "my-ns"},
		"leading digit":  {"METRICS_NAMESPACE", "1ns"},
		"no admin roles": {"OIDC_ADMIN_ROLES", " , "},
	} {
		t.Run(name, func(t *testing.T) {
			minimalEnv(t)
			clearNames(t)
			t.Setenv(kv[0], kv[1])
			if _, err := Load(RoleAll, "test"); err == nil || !strings.Contains(err.Error(), kv[0]) {
				t.Fatalf("%s=%q: got %v", kv[0], kv[1], err)
			}
		})
	}
	// The package-level collectors never see an invalid name: they fall back to the family.
	t.Setenv("METRICS_NAMESPACE", "Not Valid")
	t.Setenv("OIDC_ISSUER", "https://auth.example.com/realms/memobrain")
	if got := MetricsNamespaceFromEnv(); got != "memobrain" {
		t.Fatalf("MetricsNamespaceFromEnv() = %q", got)
	}
}

func TestMetricsNamespaceFromEnv(t *testing.T) {
	t.Setenv("METRICS_NAMESPACE", "")
	for issuer, want := range map[string]string{
		"":                                       "clarae",
		"https://auth.example.com/realms/clarae": "clarae",
		"https://auth.example.com/realms/memobrain": "memobrain",
		"https://auth.example.com/realms/acme":      "clarae",
	} {
		t.Setenv("OIDC_ISSUER", issuer)
		if got := MetricsNamespaceFromEnv(); got != want {
			t.Errorf("issuer %q: namespace %q, want %q", issuer, got, want)
		}
	}
	t.Setenv("METRICS_NAMESPACE", "ops_metrics")
	if got := MetricsNamespaceFromEnv(); got != "ops_metrics" {
		t.Errorf("explicit namespace: %q", got)
	}
}

// The default list of admin roles is kept in two places (config does not import auth, which
// would drag the API package into every binary that reads a metrics namespace).
func TestDefaultAdminRolesAgreeWithAuth(t *testing.T) {
	if got := strings.Split(defaultAdminRoles, ","); strings.Join(got, "|") != strings.Join(auth.DefaultAdminRoles, "|") {
		t.Fatalf("config default %v, auth default %v", got, auth.DefaultAdminRoles)
	}
}

// The placeholder escape hatch keeps working under its 1.x name, with a deprecation, and the
// new name wins when both are set.
func TestPlaceholderEscapeHatchUnderTheOldName(t *testing.T) {
	minimalEnv(t)
	clearNames(t)
	t.Setenv("S3_SECRET_KEY", "change-me-too")

	if _, err := Load(RoleAll, "test"); err == nil {
		t.Fatal("a placeholder secret was accepted")
	}

	t.Setenv("MEMOBRAIN_ALLOW_PLACEHOLDER_SECRETS", "1")
	c, err := Load(RoleAll, "test")
	if err != nil || !c.AllowPlaceholderSecrets {
		t.Fatalf("old name: allow %v, err %v", c.AllowPlaceholderSecrets, err)
	}
	if len(c.Deprecations) != 1 || !strings.Contains(c.Deprecations[0], "MEMOBRAIN_ALLOW_PLACEHOLDER_SECRETS") ||
		!strings.Contains(c.Deprecations[0], "CLARAE_ALLOW_PLACEHOLDER_SECRETS") || !strings.Contains(c.Deprecations[0], "2.0") {
		t.Fatalf("Deprecations = %q", c.Deprecations)
	}

	t.Setenv("CLARAE_ALLOW_PLACEHOLDER_SECRETS", "1")
	if c, err = Load(RoleAll, "test"); err != nil || !c.AllowPlaceholderSecrets || len(c.Deprecations) != 0 {
		t.Fatalf("new name: allow %v, deprecations %q, err %v", c.AllowPlaceholderSecrets, c.Deprecations, err)
	}

	// The new name is authoritative even when it says no.
	t.Setenv("CLARAE_ALLOW_PLACEHOLDER_SECRETS", "0")
	if _, err = Load(RoleAll, "test"); err == nil {
		t.Fatal("CLARAE_ALLOW_PLACEHOLDER_SECRETS=0 did not win over the old name")
	}

	// A malformed value names the variable that carries it.
	t.Setenv("CLARAE_ALLOW_PLACEHOLDER_SECRETS", "")
	t.Setenv("MEMOBRAIN_ALLOW_PLACEHOLDER_SECRETS", "yes")
	if _, err = Load(RoleAll, "test"); err == nil || !strings.Contains(err.Error(), "MEMOBRAIN_ALLOW_PLACEHOLDER_SECRETS") {
		t.Fatalf("malformed old variable: %v", err)
	}
}
