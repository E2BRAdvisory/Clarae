//go:build integration

package integration

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"memobrain/services/cloud/internal/auth/authtest"
)

func (e *env) count(sql string, args ...any) int {
	e.t.Helper()
	var n int
	if err := e.db.Pool.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}

func (c *client) subject() string {
	var sub string
	if err := c.e.db.Pool.QueryRow(context.Background(), "SELECT keycloak_sub FROM users WHERE id=$1", c.uid()).Scan(&sub); err != nil {
		c.e.t.Fatal(err)
	}
	return sub
}

func TestExportMyDataIsComplete(t *testing.T) {
	e := newEnv(t)
	ada, bob := e.user("ada-export"), e.user("bob-export")
	shared := ada.createVault("Team notes", "shared")
	private := ada.createPrivateVault("Diary")
	blob := ada.putBlob(shared, []byte("secret body text"))
	mustAccepted(t, ada.commit(shared, create(newID(), "a.md", blob))[0])
	sh := ada.share(shared, "vault", "", grantTo("user", bob.userID, "editor"))
	bob.accept(sh.id())

	resp := ada.json(http.MethodGet, "/me/export", nil)
	expect(t, resp, http.StatusOK)
	if cd := resp.Header.Get("Content-Disposition"); !strings.HasPrefix(cd, "attachment;") {
		t.Fatalf("Content-Disposition %q", cd)
	}
	raw := readAllString(t, resp)
	for _, forbidden := range []string{"secret body text", "wrapped_vmk", blob} {
		if strings.Contains(raw, forbidden) {
			t.Fatalf("export leaks %q", forbidden)
		}
	}
	got := decodeString[map[string]any](t, raw)
	profile := got["profile"].(map[string]any)
	if profile["id"] != ada.userID || profile["username"] != "ada-export" {
		t.Fatalf("profile: %v", profile)
	}
	if n := len(got["devices"].([]any)); n != 1 {
		t.Fatalf("devices: %d", n)
	}
	vaults := got["vaults"].([]any)
	names := map[string]string{}
	for _, v := range vaults {
		m := v.(map[string]any)
		names[m["name"].(string)] = m["kind"].(string)
		if m["id"] == private {
			if env := m["key_envelopes"].([]any); len(env) != 2 {
				t.Fatalf("private vault envelope kinds: %v", env)
			}
		}
	}
	if names["Team notes"] != "shared" || names["Diary"] != "private" {
		t.Fatalf("vaults: %v", names)
	}
	shares := got["shares"].([]any)
	if len(shares) != 1 {
		t.Fatalf("shares: %v", shares)
	}
	grants := shares[0].(map[string]any)["grants"].([]any)
	if len(grants) != 1 || grants[0].(map[string]any)["principal_id"] != bob.userID {
		t.Fatalf("grants: %v", grants)
	}
	actions := map[string]bool{}
	for _, a := range got["audit_log"].([]any) {
		actions[a.(map[string]any)["action"].(string)] = true
	}
	if !actions["share.create"] {
		t.Fatalf("audit log lacks share.create: %v", actions)
	}
	if got["notice"] == "" {
		t.Fatal("export carries no notice about vault content")
	}

	// The recipient sees the grant, not the owner's other data.
	bobData := decodeString[map[string]any](t, readAllString(t, bob.json(http.MethodGet, "/me/export", nil)))
	rg := bobData["received_grants"].([]any)
	if len(rg) != 1 || rg[0].(map[string]any)["permission"] != "editor" {
		t.Fatalf("received grants: %v", rg)
	}
	if len(bobData["vaults"].([]any)) != 0 {
		t.Fatal("bob's export lists vaults he does not own")
	}
	// Unauthenticated.
	r := e.request(http.MethodGet, "/me/export", "", nil)
	expect(t, r, http.StatusUnauthorized)
}

func TestDeleteAccountFlowAndPurge(t *testing.T) {
	e := newEnv(t)
	ada, bob := e.user("ada-del"), e.user("bob-del")
	shared := ada.createVault("Ada shared", "shared")
	private := ada.createPrivateVault("Ada diary")
	_ = private
	blob := ada.putBlob(shared, []byte("ada only content"))
	mustAccepted(t, ada.commit(shared, create(newID(), "a.md", blob))[0])
	toBob := ada.share(shared, "vault", "", grantTo("user", bob.userID, "viewer"))
	bob.accept(toBob.id())

	// Bob shares a vault with Ada and grants a second user access too; Ada is a manager there.
	bobVault := bob.createVault("Bob shared", "shared")
	carol := e.user("carol-del")
	bobShare := bob.share(bobVault, "vault", "", grantTo("user", ada.userID, "manager"))
	ada.accept(bobShare.id())
	expect(t, ada.json(http.MethodPut, "/shares/"+bobShare.id()+"/grants/user/"+carol.userID, map[string]any{"permission": "viewer"}), http.StatusOK)
	e.exec("UPDATE audit_log SET ip = '203.0.113.7'::inet WHERE actor_id = $1", ada.uid())
	sub := ada.subject()

	// Confirmation is mandatory and must match the username.
	expect(t, ada.json(http.MethodDelete, "/me", map[string]any{"confirm": "someone-else", "acknowledge_data_loss": true}), http.StatusBadRequest)
	// Private vault: the data-loss acknowledgement is mandatory.
	r := ada.json(http.MethodDelete, "/me", map[string]any{"confirm": "ada-del"})
	expect(t, r, http.StatusBadRequest)
	if d := decodeString[map[string]any](t, readAllString(t, r))["detail"].(string); !strings.Contains(d, "end-to-end encrypted") {
		t.Fatalf("warning missing: %s", d)
	}
	expect(t, ada.json(http.MethodGet, "/me", nil), http.StatusOK)

	expect(t, ada.json(http.MethodDelete, "/me", map[string]any{"confirm": "ada-del", "acknowledge_data_loss": true}), http.StatusNoContent)

	if e.kc.isEnabled(sub) {
		t.Fatal("the Keycloak account is still enabled")
	}
	// The token no longer works, a second deletion finds nothing and login cannot revive the row.
	expect(t, ada.json(http.MethodGet, "/me", nil), http.StatusForbidden)
	expect(t, ada.json(http.MethodDelete, "/me", map[string]any{"confirm": "ada-del"}), http.StatusForbidden)

	// Personal data is gone, ids stay.
	var status, username, email string
	var display *string
	if err := e.db.Pool.QueryRow(context.Background(), "SELECT status, username, email, display_name FROM users WHERE id=$1", ada.uid()).Scan(&status, &username, &email, &display); err != nil {
		t.Fatal(err)
	}
	if status != "deleted" || username == "ada-del" || strings.Contains(email, "memobrain.local") || display != nil {
		t.Fatalf("not anonymised: %s %s %s %v", status, username, email, display)
	}
	if n := e.count("SELECT COUNT(*) FROM devices WHERE user_id=$1 AND (revoked_at IS NULL OR name <> 'deleted device')", ada.uid()); n != 0 {
		t.Fatalf("%d identifiable devices remain", n)
	}
	if n := e.count("SELECT COUNT(*) FROM audit_log WHERE actor_id=$1", ada.uid()); n < 3 {
		t.Fatalf("audit trail lost: %d rows", n)
	}
	if n := e.count("SELECT COUNT(*) FROM audit_log WHERE actor_id=$1 AND ip IS NOT NULL", ada.uid()); n != 0 {
		t.Fatalf("%d audit rows keep the IP address", n)
	}
	if n := e.count("SELECT COUNT(*) FROM audit_log WHERE actor_id=$1 AND action='account.delete'", ada.uid()); n != 1 {
		t.Fatalf("deletion not audited: %d", n)
	}

	// Grants to Ada are gone and none names her as grantor any more; Bob's and Carol's own grants and Bob's vault are unaffected.
	if n := e.count("SELECT COUNT(*) FROM share_grants WHERE principal_id=$1 OR granted_by=$1", ada.uid()); n != 0 {
		t.Fatalf("%d grants of the deleted user remain", n)
	}
	// Carol's grant on Bob's vault was given by Ada as a manager: it stays, with Bob as grantor (ADR-0041).
	if n := e.count("SELECT COUNT(*) FROM share_grants WHERE share_id=$1 AND principal_id=$2 AND granted_by=$3", bobShare.id(), carol.uid(), bob.uid()); n != 1 {
		t.Fatalf("carol's grant on bob's vault was not kept and re-attributed to bob: %d", n)
	}
	if n := e.count("SELECT COUNT(*) FROM audit_log WHERE action='share.grants_reattributed' AND target_id=$1 AND ip IS NULL", bobShare.id()); n != 1 {
		t.Fatalf("re-attribution not audited: %d", n)
	}
	expect(t, bob.json(http.MethodGet, "/vaults/"+bobVault+"/tree", nil), http.StatusOK)
	if r := bob.json(http.MethodGet, "/vaults", nil); r.StatusCode != http.StatusOK {
		t.Fatalf("bob's vaults: %d", r.StatusCode)
	}
	// Ada's vaults are in retention: not reachable by anyone, rows still there.
	expect(t, bob.json(http.MethodGet, "/vaults/"+shared+"/tree", nil), http.StatusNotFound)
	if n := e.count("SELECT COUNT(*) FROM vaults WHERE owner_id=$1 AND deleted_at IS NOT NULL", ada.uid()); n != 2 {
		t.Fatalf("expected 2 soft-deleted vaults, got %d", n)
	}

	// A new token for the same Keycloak subject must not resurrect the account or its data.
	again := e.userWithRaw(t, "ada-del", sub)
	expect(t, again.json(http.MethodGet, "/me", nil), http.StatusForbidden)
	var after string
	if err := e.db.Pool.QueryRow(context.Background(), "SELECT username FROM users WHERE id=$1", ada.uid()).Scan(&after); err != nil || after == "ada-del" {
		t.Fatalf("login wrote personal data back: %q %v", after, err)
	}

	// Before the retention elapses the purge does nothing.
	now := time.Now()
	if n, err := e.jobs(now.Add(time.Hour)).PurgeDeletedAccounts(context.Background()); err != nil || n != 0 {
		t.Fatalf("early purge: %d %v", n, err)
	}
	// After it, the vaults, their rows and (once the grace period passed) the blobs are physically removed.
	if n, err := e.jobs(now.Add(31 * 24 * time.Hour)).PurgeDeletedAccounts(context.Background()); err != nil || n < 1 {
		t.Fatalf("purge: %d %v", n, err)
	}
	if n := e.count("SELECT COUNT(*) FROM vaults WHERE owner_id=$1", ada.uid()); n != 0 {
		t.Fatalf("%d vaults remain after the purge", n)
	}
	if n := e.count("SELECT COUNT(*) FROM files WHERE vault_id=$1", shared); n != 0 {
		t.Fatalf("%d files remain", n)
	}
	if n := e.count("SELECT COUNT(*) FROM vault_key_envelopes WHERE vault_id=$1", private); n != 0 {
		t.Fatalf("%d key envelopes remain", n)
	}
	if n := e.count("SELECT COUNT(*) FROM users WHERE id=$1 AND purged_at IS NOT NULL AND keycloak_sub LIKE 'purged:%'", ada.uid()); n != 1 {
		t.Fatal("the tombstone was not marked purged")
	}
	if n, err := e.jobs(now.Add(33 * 24 * time.Hour)).CollectBlobs(context.Background()); err != nil || n < 1 {
		t.Fatalf("blob gc: %d %v", n, err)
	}
	if n := e.count("SELECT COUNT(*) FROM blobs WHERE hash=$1", blob); n != 0 {
		t.Fatal("the blob row survived the purge and the GC")
	}
	// The purge is idempotent.
	if n, err := e.jobs(now.Add(40 * 24 * time.Hour)).PurgeDeletedAccounts(context.Background()); err != nil || n != 0 {
		t.Fatalf("second purge: %d %v", n, err)
	}
}

func TestLastAdministratorCannotDeleteTheAccount(t *testing.T) {
	e := newEnv(t)
	root := e.admin("root-del")
	e.exec("UPDATE users SET role='user' WHERE role='admin' AND id<>$1", root.uid())
	r := root.json(http.MethodDelete, "/me", map[string]any{"confirm": "root-del"})
	expect(t, r, http.StatusConflict)
	if c := problemCode(t, r); c != "INVALID_STATE" {
		t.Fatalf("code %s", c)
	}
	// With a second administrator the first may delete the account.
	other := e.admin("root-del-2")
	_ = other
	expect(t, root.json(http.MethodDelete, "/me", map[string]any{"confirm": "root-del"}), http.StatusNoContent)
}

func TestPurgeAlsoCompletesAdministratorDeletedAccounts(t *testing.T) {
	e := newEnv(t)
	root := e.admin("root-purge")
	victim := e.user("victim-purge")
	victim.createVault("Victim", "shared")
	expect(t, root.json(http.MethodDelete, "/admin/users/"+victim.userID, nil), http.StatusNoContent)
	// The administrator's deletion is the self-deletion (privacy.DeleteAccount): anonymised at once.
	if n := e.count("SELECT COUNT(*) FROM users WHERE id=$1 AND status='deleted' AND username <> 'victim-purge' AND deleted_at IS NOT NULL", victim.uid()); n != 1 {
		t.Fatal("administrator-deleted account not anonymised at once")
	}
	if _, err := e.jobs(time.Now().Add(31 * 24 * time.Hour)).PurgeDeletedAccounts(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := e.count("SELECT COUNT(*) FROM users WHERE id=$1 AND username <> 'victim-purge' AND purged_at IS NOT NULL", victim.uid()); n != 1 {
		t.Fatal("administrator-deleted account not anonymised by the purge")
	}
	if n := e.count("SELECT COUNT(*) FROM vaults WHERE owner_id=$1", victim.uid()); n != 0 {
		t.Fatal("vaults remain")
	}
	_ = uuid.Nil
}

func readAllString(t *testing.T, resp *http.Response) string {
	t.Helper()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	return string(b)
}

func decodeString[T any](t *testing.T, s string) T {
	t.Helper()
	var v T
	if err := json.Unmarshal([]byte(s), &v); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return v
}

// userWithRaw builds a client whose token carries an existing Keycloak subject.
func (e *env) userWithRaw(t *testing.T, name, subject string) *client {
	t.Helper()
	return &client{e: e, token: e.issuer.Token(t, authtest.TokenOptions{Subject: subject, Username: name, Email: name + "@memobrain.local"})}
}
