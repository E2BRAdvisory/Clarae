//go:build integration

package integration

import (
	"context"
	"net/http"
	"testing"
	"time"

	"clarae/services/cloud/internal/keycloak"
)

// Regression (M12): the purge replaced keycloak_sub, so a login with an
// identity provider account that was never disabled provisioned a new, active
// account for the same person. The purge keeps the subject's fingerprint and
// provisioning refuses it with USER_SUSPENDED (§2.6.5).
func TestPurgedSubjectCannotSignUpAgain(t *testing.T) {
	for name, c := range map[string]struct {
		kc       keycloak.Admin // the purge job's client; nil keeps the fake
		identity string
	}{
		"keycloak disabled at purge": {identity: "disabled"},
		"no keycloak admin api":      {kc: keycloak.Disabled{}, identity: "not_configured"},
	} {
		t.Run(name, func(t *testing.T) {
			e := newEnv(t)
			ada := e.user("ada-purged")
			sub := ada.subject()
			expect(t, ada.json(http.MethodDelete, "/me", map[string]any{"confirm": "ada-purged"}), http.StatusNoContent)
			if c.kc != nil {
				// The jobs runner picks the client up from the application; the
				// deletion above used the fake one.
				e.app.Keycloak = c.kc
			}
			if n, err := e.jobs(time.Now().Add(31 * 24 * time.Hour)).PurgeDeletedAccounts(context.Background()); err != nil || n < 1 {
				t.Fatalf("purge: %d %v", n, err)
			}
			if n := e.count("SELECT COUNT(*) FROM purged_subjects WHERE sub_hash = sha256(convert_to($1::text, 'UTF8'))", sub); n != 1 {
				t.Fatalf("purged subject fingerprints: %d, want 1", n)
			}
			if n := e.count("SELECT COUNT(*) FROM audit_log WHERE action = 'account.purge' AND target_id = $1 AND details->>'identity_provider' = $2",
				ada.userID, c.identity); n != 1 {
				t.Fatalf("purge audit with identity_provider=%s: %d", c.identity, n)
			}

			// A fresh token of the same subject (the status cache forgotten).
			e.authn.Invalidate(sub)
			again := e.userWithRaw(t, "ada-purged", sub)
			r := again.json(http.MethodGet, "/me", nil)
			expect(t, r, http.StatusForbidden)
			if code := problemCode(t, r); code != "USER_SUSPENDED" {
				t.Fatalf("code %s, want USER_SUSPENDED", code)
			}
			if n := e.count("SELECT COUNT(*) FROM users WHERE keycloak_sub = $1", sub); n != 0 {
				t.Fatalf("the login re-created %d account(s) for the purged subject", n)
			}
			// A second purge run finds nothing and keeps the fingerprint.
			if n, err := e.jobs(time.Now().Add(40 * 24 * time.Hour)).PurgeDeletedAccounts(context.Background()); err != nil || n != 0 {
				t.Fatalf("second purge: %d %v", n, err)
			}
		})
	}
}

// Other subjects are unaffected: a new identity still provisions an account.
func TestNewSubjectStillProvisionsAfterAPurge(t *testing.T) {
	e := newEnv(t)
	gone := e.user("gone-purged")
	expect(t, gone.json(http.MethodDelete, "/me", map[string]any{"confirm": "gone-purged"}), http.StatusNoContent)
	if _, err := e.jobs(time.Now().Add(31 * 24 * time.Hour)).PurgeDeletedAccounts(context.Background()); err != nil {
		t.Fatal(err)
	}
	fresh := e.user("fresh-after-purge")
	expect(t, fresh.json(http.MethodGet, "/me", nil), http.StatusOK)
}
