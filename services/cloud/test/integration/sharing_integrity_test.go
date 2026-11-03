//go:build integration

package integration

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"memobrain/services/cloud/internal/notify"
	"memobrain/services/cloud/internal/sharing"
	"memobrain/services/cloud/internal/vaults"
)

// Integrity of shares and grants (M12-W1): invitations sent again, idempotent answers,
// events of group changes, folder renames, the personal export and commits racing a rename.

// shareEvents returns the share events of a subscription, configuration revisions left out;
// none within wait gives nil.
func shareEvents(t *testing.T, sub *notify.Sub, wait time.Duration) []notify.Event {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), wait)
	defer cancel()
	for {
		evs, err := sub.Next(ctx)
		if err != nil {
			return nil
		}
		var kept []notify.Event
		for _, ev := range evs {
			if ev.Kind == notify.KindShare {
				kept = append(kept, ev)
			}
		}
		if len(kept) > 0 {
			return kept
		}
	}
}

func TestDeclinedInvitationIsAskedAgain(t *testing.T) {
	_, ada, bob, _, vault, _, _ := sharedFixture(t)
	sh := ada.share(vault, "vault", "", grantTo("user", bob.userID, "viewer"))
	expect(t, bob.json(http.MethodPost, "/shares/"+sh.id()+":decline", nil), http.StatusOK)
	// A retried decline (the first answer lost on the way) is no error.
	resp := bob.json(http.MethodPost, "/shares/"+sh.id()+":decline", nil)
	expect(t, resp, http.StatusOK)
	if got := decode[shareView](t, resp); got["my_status"] != "declined" {
		t.Fatalf("after a second decline: %v", got)
	}
	if r := pageItems[shareView](t, bob.json(http.MethodGet, "/shares?scope=received", nil)); len(r) != 0 {
		t.Fatalf("a declined invitation is not listed: %v", r)
	}

	// Inviting again asks again.
	resp = ada.json(http.MethodPut, "/shares/"+sh.id()+"/grants/user/"+bob.userID, map[string]any{"permission": "editor"})
	expect(t, resp, http.StatusOK)
	if g := decode[map[string]any](t, resp); g["status"] != "pending" {
		t.Fatalf("grant given again: %v", g)
	}
	r := pageItems[shareView](t, bob.json(http.MethodGet, "/shares?scope=received", nil))
	if len(r) != 1 || r[0]["my_status"] != "pending" {
		t.Fatalf("the new invitation: %v", r)
	}
	// A level changed on an accepted grant keeps the answer.
	bob.accept(sh.id())
	resp = ada.json(http.MethodPut, "/shares/"+sh.id()+"/grants/user/"+bob.userID, map[string]any{"permission": "viewer"})
	expect(t, resp, http.StatusOK)
	if g := decode[map[string]any](t, resp); g["status"] != "accepted" {
		t.Fatalf("level changed on an accepted grant: %v", g)
	}
}

// A member joining or leaving a group, or the group removed, tells the users concerned that
// a share appeared or went, as a grant added or removed does; a user still reached by
// another grant hears nothing.
func TestGroupChangesSendShareEvents(t *testing.T) {
	e, ada, bob, carol, vault, _, group := sharedFixture(t)
	ctx := context.Background()
	eve := e.user("eve")
	sh := ada.share(vault, "folder", "Projects/Alfa", grantTo("group", group.String(), "editor"), grantTo("user", bob.userID, "viewer"))
	carol.accept(sh.id())
	eveSub := e.app.Hub.Subscribe(eve.uid())
	defer e.app.Hub.Unsubscribe(eveSub)
	bobSub := e.app.Hub.Subscribe(bob.uid())
	defer e.app.Hub.Unsubscribe(bobSub)
	expectEvent := func(sub *notify.Sub, kind string) {
		t.Helper()
		evs := shareEvents(t, sub, 5*time.Second)
		if len(evs) != 1 || evs[0].ShareID.String() != sh.id() || evs[0].ShareKind != kind {
			t.Fatalf("want %s: %+v", kind, evs)
		}
	}

	if err := e.app.Groups.SetMember(ctx, ada.uid(), group, eve.uid(), "member"); err != nil {
		t.Fatal(err)
	}
	expectEvent(eveSub, notify.ShareGranted)
	if m := pageItems[map[string]any](t, eve.json(http.MethodGet, "/shared-with-me", nil)); len(m) != 1 {
		t.Fatalf("a new member mounts the accepted group share: %v", m)
	}
	// A change of role gives and takes nothing.
	if err := e.app.Groups.SetMember(ctx, ada.uid(), group, eve.uid(), "manager"); err != nil {
		t.Fatal(err)
	}
	if evs := shareEvents(t, eveSub, 500*time.Millisecond); evs != nil {
		t.Fatalf("role change: %+v", evs)
	}
	if err := e.app.Groups.RemoveMember(ctx, ada.uid(), group, eve.uid()); err != nil {
		t.Fatal(err)
	}
	expectEvent(eveSub, notify.ShareRevoked)

	// bob keeps his own grant: leaving the group takes nothing away from him.
	if err := e.app.Groups.RemoveMember(ctx, ada.uid(), group, bob.uid()); err != nil {
		t.Fatal(err)
	}
	if evs := shareEvents(t, bobSub, 500*time.Millisecond); evs != nil {
		t.Fatalf("bob is still reached: %+v", evs)
	}

	if err := e.app.Groups.SetMember(ctx, ada.uid(), group, eve.uid(), "member"); err != nil {
		t.Fatal(err)
	}
	expectEvent(eveSub, notify.ShareGranted)
	if err := e.app.Groups.Delete(ctx, ada.uid(), group); err != nil {
		t.Fatal(err)
	}
	expectEvent(eveSub, notify.ShareRevoked)
	if m := pageItems[map[string]any](t, eve.json(http.MethodGet, "/shared-with-me", nil)); len(m) != 0 {
		t.Fatalf("after the group went: %v", m)
	}
}

// A folder rename carries the shares whose prefix has the same path key as the folder
// (case folded, NFC), as every scope check compares, not lower().
func TestFolderRenameCarriesSharesByPathKey(t *testing.T) {
	e := newEnv(t)
	ada, bob := e.user("ada"), e.user("bob")
	vault := ada.createVault("V", "shared")
	ada.seed(vault, map[string]string{"Straße/a.md": "a", "Straße/Unten/b.md": "b"})
	upper := ada.share(vault, "folder", "STRASSE", grantTo("user", bob.userID, "viewer"))
	below := ada.share(vault, "folder", "strasse/unten", grantTo("user", bob.userID, "viewer"))
	mustAccepted(t, ada.commit(vault, map[string]any{"op_id": newID(), "op": "move_prefix", "from": "Straße", "to": "Archivio/Straße"})[0])
	for sh, want := range map[string]string{upper.id(): "Archivio/Straße", below.id(): "Archivio/Straße/unten"} {
		if got := decode[shareView](t, ada.json(http.MethodGet, "/shares/"+sh, nil))["path_prefix"]; got != want {
			t.Errorf("share %s: prefix %v, want %s", sh, got, want)
		}
	}
	bob.accept(upper.id())
	resp := bob.json(http.MethodGet, "/vaults/"+vault+"/tree?scope=share:"+upper.id(), nil)
	expect(t, resp, http.StatusOK)
	if items := decode[struct{ Items []map[string]any }](t, resp).Items; len(items) != 2 {
		t.Fatalf("the share followed its folder: %v", items)
	}
}

// GET /me/export lists the recipients of a share created as a manager only while its
// creator still manages it (ADR-0041 §8); the share itself stays in the export.
func TestExportShowsRecipientsOnlyOfManagedShares(t *testing.T) {
	_, ada, bob, carol, vault, _, _ := sharedFixture(t)
	alfa := ada.share(vault, "folder", "Projects/Alfa", grantTo("user", bob.userID, "manager"))
	bob.accept(alfa.id())
	resp := bob.createShare(map[string]any{"vault_id": vault, "resource_type": "folder", "path_prefix": "Projects/Alfa/sub",
		"grants": []map[string]any{grantTo("user", carol.userID, "editor")}})
	expect(t, resp, http.StatusCreated)
	sub := decode[shareView](t, resp).id()
	exported := func(c *client) map[string]map[string]any {
		t.Helper()
		data := decodeString[map[string]any](t, readAllString(t, c.json(http.MethodGet, "/me/export", nil)))
		out := map[string]map[string]any{}
		for _, s := range data["shares"].([]any) {
			m := s.(map[string]any)
			out[m["id"].(string)] = m
		}
		return out
	}
	if g, _ := exported(bob)[sub]["grants"].([]any); len(g) != 1 {
		t.Fatalf("a managing creator exports the grants: %v", exported(bob)[sub])
	}
	expect(t, ada.json(http.MethodDelete, "/shares/"+alfa.id()+"/grants/user/"+bob.userID, nil), http.StatusNoContent)
	got := exported(bob)[sub]
	if got == nil || got["created_by"] != bob.userID {
		t.Fatalf("the created share stays in the export: %v", got)
	}
	if _, ok := got["grants"]; ok {
		t.Fatalf("a former manager exports the recipients: %v", got)
	}
	if g, _ := exported(ada)[sub]["grants"].([]any); len(g) != 1 {
		t.Fatalf("the owner exports the grants: %v", exported(ada)[sub])
	}
}

// A commit through a share is authorised before it takes the vault lock; a rename (or a
// revocation) of the share's root committed meanwhile must not have the commit resolve its
// paths against the old root. The commit is refused, the client pulls and sends it again.
func TestCommitThroughAShareRechecksItUnderTheVaultLock(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	ada, bob := e.user("ada"), e.user("bob")
	vault := ada.createVault("V", "shared")
	vid := uuid.MustParse(vault)
	ada.seed(vault, map[string]string{"Team/a.md": "a", "Other/b.md": "b"})
	team := ada.share(vault, "folder", "Team", grantTo("user", bob.userID, "editor"))
	other := ada.share(vault, "folder", "Other", grantTo("user", bob.userID, "editor"))
	bob.accept(team.id())
	bob.accept(other.id())
	h := bob.scopedPut(t, vault, team.id(), []byte("note"))

	// change runs under the vault lock while bob's commit waits for it.
	race := func(share string, change func(tx pgx.Tx) error) *http.Response {
		t.Helper()
		tx, err := e.db.Pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		if err := vaults.LockVault(ctx, tx, vid); err != nil {
			t.Fatal(err)
		}
		if err := change(tx); err != nil {
			t.Fatal(err)
		}
		done := make(chan *http.Response, 1)
		go func() {
			done <- bob.json(http.MethodPost, "/vaults/"+vault+"/commit?scope=share:"+share,
				map[string]any{"device_id": bob.deviceID, "ops": []map[string]any{create(newID(), "nota.md", h)}})
		}()
		for deadline := time.Now().Add(10 * time.Second); ; {
			var n int
			if err := e.db.Pool.QueryRow(ctx, "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%FOR NO KEY UPDATE%'").Scan(&n); err != nil {
				t.Fatal(err)
			}
			if n > 0 {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("the commit never waited for the vault lock")
			}
			time.Sleep(20 * time.Millisecond)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		return <-done
	}

	// The owner renames Team (move_prefix rebases the share under the lock).
	resp := race(team.id(), func(tx pgx.Tx) error {
		return sharing.RebasePrefixShares(ctx, tx, sharing.RebasePrefixSharesParams{VaultID: vid, FromPath: "Team", ToPath: "Team-2025"})
	})
	expect(t, resp, http.StatusConflict)
	if c := problemCode(t, resp); c != "INVALID_STATE" {
		t.Fatalf("code %s", c)
	}
	if paths, _ := ada.tree(vault); paths["Team/nota.md"] != nil {
		t.Fatalf("the commit wrote outside the moved share: %v", paths)
	}
	// Sent again, it lands under the new root.
	res, code := bob.scopedCommit(vault, team.id(), create(newID(), "nota.md", h))
	if code != http.StatusOK {
		t.Fatalf("retry: %d", code)
	}
	mustAccepted(t, res[0])
	if paths, _ := ada.tree(vault); paths["Team-2025/nota.md"] == nil {
		t.Fatalf("after the retry: %v", paths)
	}

	// The owner revokes Other meanwhile: nothing is written.
	resp = race(other.id(), func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, "UPDATE shares SET revoked_at = now() WHERE id = $1", other.id())
		return err
	})
	expect(t, resp, http.StatusNotFound)
	if paths, _ := ada.tree(vault); paths["Other/nota.md"] != nil {
		t.Fatalf("the commit went through a revoked share: %v", paths)
	}
}

// A manager grant lowered below manager, or declined after it was accepted, also takes the
// grants another manager gave the creator on what they created inside it.
func TestManagerGrantLoweredOrDeclinedDropsCreatorGrants(t *testing.T) {
	e, ada, bob, carol, vault, _, _ := sharedFixture(t)
	eve := e.user("eve")
	alfa := ada.share(vault, "folder", "Projects/Alfa", grantTo("user", bob.userID, "manager"),
		grantTo("user", carol.userID, "manager"), grantTo("user", eve.userID, "manager"))
	for _, c := range []*client{bob, carol, eve} {
		c.accept(alfa.id())
	}
	created := func(c *client, prefix string) string {
		t.Helper()
		resp := c.createShare(map[string]any{"vault_id": vault, "resource_type": "folder", "path_prefix": prefix,
			"grants": []map[string]any{grantTo("user", eve.userID, "manager")}})
		expect(t, resp, http.StatusCreated)
		id := decode[shareView](t, resp).id()
		eve.accept(id)
		expect(t, eve.json(http.MethodPut, "/shares/"+id+"/grants/user/"+c.userID, map[string]any{"permission": "editor"}), http.StatusOK)
		c.accept(id)
		if _, _, _, code := c.scopedChanges(vault, id, 0); code != http.StatusOK {
			t.Fatalf("before: %d", code)
		}
		return id
	}
	byBob, byCarol := created(bob, "Projects/Alfa/sub"), created(carol, "Projects/Alfa")

	expect(t, ada.json(http.MethodPut, "/shares/"+alfa.id()+"/grants/user/"+bob.userID, map[string]any{"permission": "editor"}), http.StatusOK)
	if _, _, _, code := bob.scopedChanges(vault, byBob, 0); code != http.StatusNotFound {
		t.Fatalf("bob's manager grant was lowered: %d", code)
	}
	if _, _, _, code := carol.scopedChanges(vault, byCarol, 0); code != http.StatusOK {
		t.Fatalf("carol still manages: %d", code)
	}
	expect(t, carol.json(http.MethodPost, "/shares/"+alfa.id()+":decline", nil), http.StatusOK)
	if _, _, _, code := carol.scopedChanges(vault, byCarol, 0); code != http.StatusNotFound {
		t.Fatalf("carol declined her manager grant: %d", code)
	}
	// What eve was given stays: only the creators lose their grants.
	if _, _, _, code := eve.scopedChanges(vault, byBob, 0); code != http.StatusOK {
		t.Fatalf("eve: %d", code)
	}
}

// Leaving a group takes the share from a member whose own grant on it was declined: the
// group was what still gave it to them, and they are told.
func TestLeavingAGroupWithADeclinedGrantRevokes(t *testing.T) {
	e, ada, bob, carol, vault, _, group := sharedFixture(t)
	sh := ada.share(vault, "folder", "Projects/Alfa", grantTo("group", group.String(), "editor"), grantTo("user", carol.userID, "viewer"))
	bob.accept(sh.id())
	expect(t, carol.json(http.MethodPost, "/shares/"+sh.id()+":decline", nil), http.StatusOK)
	if _, _, _, code := carol.scopedChanges(vault, sh.id(), 0); code != http.StatusOK {
		t.Fatalf("carol reaches the share through the group: %d", code)
	}
	sub := e.app.Hub.Subscribe(carol.uid())
	defer e.app.Hub.Unsubscribe(sub)
	if err := e.app.Groups.RemoveMember(context.Background(), ada.uid(), group, carol.uid()); err != nil {
		t.Fatal(err)
	}
	evs := shareEvents(t, sub, 5*time.Second)
	if len(evs) != 1 || evs[0].ShareID.String() != sh.id() || evs[0].ShareKind != notify.ShareRevoked {
		t.Fatalf("want revoked: %+v", evs)
	}
	if _, _, _, code := carol.scopedChanges(vault, sh.id(), 0); code != http.StatusNotFound {
		t.Fatalf("after leaving: %d", code)
	}
}

// A creator who manages a share they created through a manager grant the owner gave them on
// it keeps exporting its recipients after losing the share around it, as the share shows them.
func TestExportShowsRecipientsOfSharesManagedByGrant(t *testing.T) {
	_, ada, bob, carol, vault, _, _ := sharedFixture(t)
	alfa := ada.share(vault, "folder", "Projects/Alfa", grantTo("user", bob.userID, "manager"))
	bob.accept(alfa.id())
	resp := bob.createShare(map[string]any{"vault_id": vault, "resource_type": "folder", "path_prefix": "Projects/Alfa/sub",
		"grants": []map[string]any{grantTo("user", carol.userID, "editor")}})
	expect(t, resp, http.StatusCreated)
	sub := decode[shareView](t, resp).id()
	expect(t, ada.json(http.MethodPut, "/shares/"+sub+"/grants/user/"+bob.userID, map[string]any{"permission": "manager"}), http.StatusOK)
	bob.accept(sub)
	expect(t, ada.json(http.MethodDelete, "/shares/"+alfa.id()+"/grants/user/"+bob.userID, nil), http.StatusNoContent)
	data := decodeString[map[string]any](t, readAllString(t, bob.json(http.MethodGet, "/me/export", nil)))
	for _, s := range data["shares"].([]any) {
		m := s.(map[string]any)
		if m["id"] != sub {
			continue
		}
		if g, _ := m["grants"].([]any); len(g) != 2 {
			t.Fatalf("bob manages the share by the owner's grant: %v", m)
		}
		return
	}
	t.Fatalf("share %s not exported", sub)
}
