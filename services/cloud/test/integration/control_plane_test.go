//go:build integration

package integration

import (
	"context"
	"net/http"
	"net/url"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"memobrain/services/cloud/internal/auth/authtest"
	"memobrain/services/cloud/internal/notify"
)

// tokenAt mints a token for an existing subject with the given realm roles and iat.
func (e *env) tokenAt(subject, username, email string, iat time.Time, roles ...string) string {
	e.t.Helper()
	return e.issuer.Token(e.t, authtest.TokenOptions{Subject: subject, Username: username, Email: email, Roles: roles, IssuedAt: iat})
}

func (e *env) roleOf(id uuid.UUID) string {
	e.t.Helper()
	var role string
	if err := e.db.Pool.QueryRow(context.Background(), "SELECT role FROM users WHERE id=$1", id).Scan(&role); err != nil {
		e.t.Fatal(err)
	}
	return role
}

// Regression (W8, role-mirror-overwritten-by-stale-token): after a demotion
// the next request with the user's still valid access token re-provisioned
// role=admin from its realm roles, undoing the change until the token expired.
func TestDemotionHoldsAgainstTokensIssuedBefore(t *testing.T) {
	e := newEnv(t)
	root := e.admin("root-demote")
	sub := "sub-demoted-" + uuid.NewString()
	email := "demoted-" + uuid.NewString()[:8] + "@memobrain.local"
	before := time.Now().Add(-time.Minute)
	b := &client{e: e, token: e.tokenAt(sub, "demoted", email, before, "memobrain-admin", "memobrain-user")}
	b.userID = decode[map[string]any](t, b.json(http.MethodGet, "/me", nil))["id"].(string)
	expect(t, b.json(http.MethodGet, "/admin/users", nil), http.StatusOK)

	expect(t, root.json(http.MethodPut, "/admin/users/"+b.userID+"/role", map[string]any{"role": "user"}), http.StatusOK)

	// The old token still carries memobrain-admin: it no longer opens the console.
	expect(t, b.json(http.MethodGet, "/admin/users", nil), http.StatusForbidden)
	if me := decode[map[string]any](t, b.json(http.MethodGet, "/me", nil)); me["role"] != "user" {
		t.Fatalf("/me role %v after the demotion", me["role"])
	}
	if r := e.roleOf(b.uid()); r != "user" {
		t.Fatalf("the old token wrote role %s back", r)
	}
	// A token issued after the change mirrors the identity provider again,
	// which now says user...
	later := time.Now().Add(2 * time.Second)
	b.token = e.tokenAt(sub, "demoted", email, later, "memobrain-user")
	e.authn.Invalidate(sub)
	expect(t, b.json(http.MethodGet, "/admin/users", nil), http.StatusForbidden)
	// ...and a role granted again directly in Keycloak afterwards wins.
	b.token = e.tokenAt(sub, "demoted", email, later.Add(time.Second), "memobrain-admin", "memobrain-user")
	e.authn.Invalidate(sub)
	expect(t, b.json(http.MethodGet, "/admin/users", nil), http.StatusOK)
	if r := e.roleOf(b.uid()); r != "admin" {
		t.Fatalf("a newer token must mirror the realm role, got %s", r)
	}
}

// The mirror image: a promotion applies at once, without waiting for a new token.
func TestPromotionAppliesBeforeANewToken(t *testing.T) {
	e := newEnv(t)
	root := e.admin("root-promote")
	u := e.user("promoted")
	expect(t, u.json(http.MethodGet, "/admin/users", nil), http.StatusForbidden)
	expect(t, root.json(http.MethodPut, "/admin/users/"+u.userID+"/role", map[string]any{"role": "admin"}), http.StatusOK)
	// The token (realm role user) predates the promotion.
	expect(t, u.json(http.MethodGet, "/admin/users", nil), http.StatusOK)
	if got := decode[adminUser](t, root.json(http.MethodGet, "/admin/users/"+u.userID, nil)); got.Role != "admin" {
		t.Fatalf("the console shows %s", got.Role)
	}
}

// Regression (W8, provision-email-unique-lockout): a token whose e-mail
// belongs to another live account (an identity provider account recreated
// with a new subject) got 500 INTERNAL on every request.
func TestProvisioningEmailConflictIsAClearProblem(t *testing.T) {
	e := newEnv(t)
	root := e.admin("root-conflict")
	email := "twin-" + uuid.NewString()[:8] + "@memobrain.local"
	first := &client{e: e, token: e.issuer.Token(t, authtest.TokenOptions{Subject: "sub-first-" + uuid.NewString(), Username: "twin", Email: email})}
	first.userID = decode[map[string]any](t, first.json(http.MethodGet, "/me", nil))["id"].(string)

	sub := "sub-recreated-" + uuid.NewString()
	second := &client{e: e, token: e.issuer.Token(t, authtest.TokenOptions{Subject: sub, Username: "twin2", Email: email})}
	for range 3 {
		r := second.json(http.MethodGet, "/me", nil)
		expect(t, r, http.StatusConflict)
		if c := problemCode(t, r); c != "INVALID_STATE" {
			t.Fatalf("code %s", c)
		}
	}
	if n := e.count("SELECT COUNT(*) FROM users WHERE keycloak_sub=$1", sub); n != 0 {
		t.Fatalf("a row was created for the conflicting subject: %d", n)
	}
	// The administrator resolves it by deleting the stale account; the next
	// attempt (after the cached refusal expires, here invalidated) links.
	expect(t, root.json(http.MethodDelete, "/admin/users/"+first.userID, nil), http.StatusNoContent)
	e.authn.Invalidate(sub)
	expect(t, second.json(http.MethodGet, "/me", nil), http.StatusOK)
}

// Provisioning writes only when something changed: a request with an
// unchanged token leaves the row (and last_login_at) alone, and a suspended
// account is never written.
func TestProvisioningDoesNotWriteOnEveryCacheMiss(t *testing.T) {
	e := newEnv(t)
	root := e.admin("root-touch")
	u := e.user("touch")
	var first time.Time
	if err := e.db.Pool.QueryRow(context.Background(), "SELECT updated_at FROM users WHERE id=$1", u.uid()).Scan(&first); err != nil {
		t.Fatal(err)
	}
	e.authn.Invalidate(u.subject())
	expect(t, u.json(http.MethodGet, "/me", nil), http.StatusOK)
	var again time.Time
	if err := e.db.Pool.QueryRow(context.Background(), "SELECT updated_at FROM users WHERE id=$1", u.uid()).Scan(&again); err != nil {
		t.Fatal(err)
	}
	if !again.Equal(first) {
		t.Fatalf("an unchanged token rewrote the row: %v -> %v", first, again)
	}

	expect(t, root.json(http.MethodPost, "/admin/users/"+u.userID+":suspend", nil), http.StatusOK)
	e.exec("UPDATE users SET last_login_at = now() - interval '2 hours' WHERE id=$1", u.uid())
	for range 3 {
		e.authn.Invalidate(u.subject())
		expect(t, u.json(http.MethodGet, "/me", nil), http.StatusForbidden)
	}
	if n := e.count("SELECT COUNT(*) FROM users WHERE id=$1 AND last_login_at > now() - interval '1 hour'", u.uid()); n != 0 {
		t.Fatal("a suspended account's requests bumped last_login_at")
	}
}

// onlyAdmins demotes every other administrator in the shared database.
func (e *env) onlyAdmins(ids ...uuid.UUID) {
	e.t.Helper()
	keep := make([]string, len(ids))
	for i, id := range ids {
		keep[i] = id.String()
	}
	e.exec("UPDATE users SET role='user' WHERE role='admin' AND NOT (id = ANY($1::uuid[]))", keep)
}

// Regression (W8, last-admin-guard-race): two administrators suspending,
// demoting or deleting each other at the same time both passed an unlocked
// count and left no active administrator.
func TestConcurrentRemovalsKeepAnActiveAdministrator(t *testing.T) {
	e := newEnv(t)
	type action struct {
		name        string
		method, sfx string
		body        any
	}
	for _, a := range []action{
		{"suspend", http.MethodPost, ":suspend", nil},
		{"demote", http.MethodPut, "/role", map[string]any{"role": "user"}},
		{"delete", http.MethodDelete, "", nil},
	} {
		t.Run(a.name, func(t *testing.T) {
			for round := range 5 {
				x := e.admin("x-" + a.name + "-" + uuid.NewString()[:4])
				y := e.admin("y-" + a.name + "-" + uuid.NewString()[:4])
				e.onlyAdmins(x.uid(), y.uid())
				var wg sync.WaitGroup
				codes := make([]int, 2)
				start := make(chan struct{})
				for i, pair := range [][2]*client{{x, y}, {y, x}} {
					wg.Add(1)
					go func() {
						defer wg.Done()
						<-start
						r := pair[0].json(a.method, "/admin/users/"+pair[1].userID+a.sfx, a.body)
						codes[i] = r.StatusCode
						_ = r.Body.Close()
					}()
				}
				close(start)
				wg.Wait()
				if n := e.count("SELECT COUNT(*) FROM users WHERE role='admin' AND status='active'"); n != 1 {
					t.Fatalf("round %d: %d active administrators left (responses %v)", round, n, codes)
				}
				ok := 0
				for _, c := range codes {
					if c >= 200 && c < 300 {
						ok++
					}
				}
				if ok != 1 {
					t.Fatalf("round %d: responses %v, want exactly one success", round, codes)
				}
			}
		})
	}
}

// Regression (W8, directory-email-oracle): a substring of an e-mail found the
// user, so addresses could be confirmed piece by piece.
func TestDirectoryMatchesEmailOnlyExactly(t *testing.T) {
	e := newEnv(t)
	email := "Hidden.Person-" + uuid.NewString()[:8] + "@acme.example"
	target := &client{e: e, token: e.issuer.Token(t, authtest.TokenOptions{Subject: "sub-dir-" + uuid.NewString(), Username: "dir-" + uuid.NewString()[:6], Email: email})}
	target.userID = decode[map[string]any](t, target.json(http.MethodGet, "/me", nil))["id"].(string)
	asker := e.user("asker")
	find := func(q string) bool {
		t.Helper()
		resp := asker.json(http.MethodGet, "/directory/users?q="+url.QueryEscape(q), nil)
		expect(t, resp, http.StatusOK)
		for _, u := range decode[[]map[string]any](t, resp) {
			if u["id"] == target.userID {
				return true
			}
		}
		return false
	}
	if !find(email) {
		t.Fatal("the exact address must find the user (sharing by e-mail)")
	}
	if !find("hidden.person-" + email[len("Hidden.Person-"):]) {
		t.Fatal("the exact match is case-insensitive")
	}
	for _, partial := range []string{"Hidden.Person", "@acme.example", email[:len(email)-1], "%acme.example", "Hidden_Person"} {
		if find(partial) {
			t.Fatalf("partial e-mail %q found the user", partial)
		}
	}
}

// Regression (W8, contract-drift): /me reported config_version 0 forever.
func TestMeReportsTheConfigurationRevision(t *testing.T) {
	e := newEnv(t)
	u := e.user("cfgver")
	var rev int64
	if err := e.db.Pool.QueryRow(context.Background(), "SELECT (value #>> '{}')::bigint FROM settings WHERE key='config.revision'").Scan(&rev); err != nil {
		t.Skipf("no config revision setting: %v", err)
	}
	me := decode[map[string]any](t, u.json(http.MethodGet, "/me", nil))
	if got := int64(me["config_version"].(float64)); got != rev {
		t.Fatalf("config_version %d, want %d", got, rev)
	}
}

// Regression (W8, notify-reconnect-loses-events): NOTIFYs sent while the
// listening connection was down were lost and subscribers never caught up.
// After the listener reconnects the hub resyncs them from the database.
func TestListenerReconnectResyncsSubscribers(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada-relisten")
	v := ada.createVault("Relisten", "shared")
	sub := e.app.Hub.Subscribe(ada.uid())
	defer e.app.Hub.Unsubscribe(sub)
	ctx := context.Background()
	listeners := func() int {
		return e.count("SELECT COUNT(*) FROM pg_stat_activity WHERE datname = current_database() AND query LIKE 'LISTEN %' AND pid <> pg_backend_pid()")
	}
	deadline := time.Now().Add(10 * time.Second)
	for listeners() == 0 {
		if time.Now().After(deadline) {
			t.Fatal("the hub never started listening")
		}
		time.Sleep(50 * time.Millisecond)
	}
	e.exec("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND query LIKE 'LISTEN %' AND pid <> pg_backend_pid()")
	for listeners() != 0 {
		time.Sleep(10 * time.Millisecond)
	}
	// Committed while nobody listens: the NOTIFY is gone.
	mustAccepted(t, ada.commit(v, create(newID(), "gap.md", ada.putBlob(v, []byte("written during the gap"))))[0])
	if listeners() != 0 {
		t.Skip("the listener came back before the commit: the gap was not exercised")
	}
	var seq int64
	if err := e.db.Pool.QueryRow(ctx, "SELECT last_seq FROM vaults WHERE id=$1", v).Scan(&seq); err != nil {
		t.Fatal(err)
	}
	wait, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	for {
		batch, err := sub.Next(wait)
		if err != nil {
			t.Fatalf("no resync after the listener reconnected: %v", err)
		}
		for _, ev := range batch {
			if ev.Kind == notify.KindVault && ev.VaultID.String() == v && ev.Seq >= seq {
				return
			}
		}
	}
}

// The tombstone purge is one set-based statement across vaults now (W8,
// maintenance-n-plus-one): a tombstone that a file share still points at must
// stay (deleting it would violate shares.file_id and fail the whole batch),
// every other tombstone without history goes.
func TestTombstonePurgeKeepsFilesAFileSharePointsAt(t *testing.T) {
	e := newEnv(t)
	ada, bob := e.user("ada-tomb"), e.user("bob-tomb")
	v := ada.createVault("Tombstones", "shared")
	ids := ada.seed(v, map[string]string{"shared.md": "shared", "plain.md": "plain"})
	expect(t, ada.json(http.MethodPost, "/shares", map[string]any{
		"vault_id": v, "resource_type": "file", "file_id": ids["shared.md"], "display_name": "One file",
		"grants": []map[string]any{grantTo("user", bob.userID, "viewer")},
	}), http.StatusCreated)
	for _, p := range []string{"shared.md", "plain.md"} {
		mustAccepted(t, ada.commit(v, del(ids[p], 1))[0])
	}
	// History gone (as after the retention), tombstones left.
	e.exec("DELETE FROM file_revisions WHERE vault_id = $1", v)
	if _, err := e.jobs(time.Now()).PruneRevisions(context.Background()); err != nil {
		t.Fatalf("the purge failed: %v", err)
	}
	if n := e.count("SELECT COUNT(*) FROM files WHERE id = $1", ids["plain.md"]); n != 0 {
		t.Fatal("a tombstone without history survived the purge")
	}
	if n := e.count("SELECT COUNT(*) FROM files WHERE id = $1", ids["shared.md"]); n != 1 {
		t.Fatal("the tombstone a file share points at was deleted")
	}
}
