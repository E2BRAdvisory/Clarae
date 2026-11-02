//go:build integration

package integration

import (
	"context"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"memobrain/shared/syncproto"
)

func (e *env) refCount(hash string) int {
	e.t.Helper()
	return e.count(`SELECT ref_count FROM blobs WHERE hash = $1`, hash)
}

// Regression (M12, tombstone-purge-dead): the current revision of a tombstone
// is its delete, which retention never prunes, so the tombstone purge never
// found anything to delete. A tombstone past both the daily history and the
// changelog window now goes with its delete revision, and the compaction
// point moves past the delete so that an older cursor bootstraps.
func TestTombstonePurgeAfterTheHistoryAndTheWindow(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada-expiry")
	v := ada.createVault("Tombstone expiry", "shared")
	now := time.Now().UTC()
	old, recent := newID(), newID()
	h := ada.putBlob(v, []byte("old "+newID()))
	created := mustAccepted(t, ada.commit(v, create(old, "old.md", h))[0])
	deleted := mustAccepted(t, ada.commit(v, del(old, 1))[0])
	mustAccepted(t, ada.commit(v, create(recent, "recent.md", ada.putBlob(v, []byte("recent "+newID()))))[0])
	mustAccepted(t, ada.commit(v, del(recent, 1))[0])
	// Deleted 100 days ago (past both 90-day limits) and 50 days ago (inside them).
	e.setRevisionTimes(old, now.AddDate(0, 0, -200), now.AddDate(0, 0, -100))
	e.setRevisionTimes(recent, now.AddDate(0, 0, -60), now.AddDate(0, 0, -50))

	if _, err := e.jobs(now).PruneRevisions(ctxBg()); err != nil {
		t.Fatal(err)
	}
	if n := e.count(`SELECT COUNT(*) FROM files WHERE id = $1`, old); n != 0 {
		t.Fatal("an expired tombstone survived the purge")
	}
	if n := e.count(`SELECT COUNT(*) FROM file_revisions WHERE file_id = $1`, old); n != 0 {
		t.Fatalf("%d revisions of a purged tombstone left", n)
	}
	if n := e.count(`SELECT COUNT(*) FROM file_revisions WHERE file_id = $1 AND rev_no = 2`, recent); n != 1 {
		t.Fatal("a tombstone inside the window lost its delete revision")
	}
	if n := e.count(`SELECT COUNT(*) FROM files WHERE id = $1 AND is_deleted`, recent); n != 1 {
		t.Fatal("a tombstone inside the window was purged")
	}
	if refs := e.refCount(h); refs != 0 {
		t.Fatalf("ref_count of the purged file's blob = %d", refs)
	}
	// A cursor from before the delete would never hear of it: it must bootstrap.
	resp := ada.json(http.MethodGet, fmt.Sprintf("/vaults/%s/changes?since=%d", v, created.seq()), nil)
	expect(t, resp, http.StatusGone)
	if p := decode[syncproto.Problem](t, resp); p.Code != syncproto.CodeCursorExpired {
		t.Fatalf("code %s", p.Code)
	}
	// One that saw the delete continues.
	items, _, _ := ada.changes(v, deleted.seq())
	for _, it := range items {
		if it["file_id"] == old {
			t.Fatalf("purged tombstone still served: %v", it)
		}
	}
	tree, _ := ada.tree(v)
	if len(tree) != 0 {
		t.Fatalf("tree of a vault with only deleted files: %v", tree)
	}
}

// A tombstone whose history retention has not pruned (yet) takes it along and
// releases its blob references; the purge walks the tombstones in keyset pages
// across vaults and goes past the ones a file share keeps.
func TestTombstonePurgeReleasesTheHistoryLeft(t *testing.T) {
	e := newEnv(t)
	ada, bob := e.user("ada-left"), e.user("bob-left")
	now := time.Now().UTC()
	var hashes, files []string
	for _, name := range []string{"History left A", "History left B"} {
		v := ada.createVault(name, "shared")
		for i := range 2 {
			f := newID()
			h1 := ada.putBlob(v, []byte(fmt.Sprintf("first %d %s", i, newID())))
			h2 := ada.putBlob(v, []byte(fmt.Sprintf("second %d %s", i, newID())))
			mustAccepted(t, ada.commit(v, create(f, fmt.Sprintf("n%d.md", i), h1))[0])
			mustAccepted(t, ada.commit(v, modify(f, 1, h2))[0])
			mustAccepted(t, ada.commit(v, del(f, 2))[0])
			e.setRevisionTimes(f, now.AddDate(0, 0, -120), now.AddDate(0, 0, -110), now.AddDate(0, 0, -100))
			hashes, files = append(hashes, h1, h2), append(files, f)
		}
	}
	// A tombstone a file share points at stays, whatever its age.
	v := ada.createVault("History left shared", "shared")
	kept := ada.seed(v, map[string]string{"kept.md": "kept " + newID()})["kept.md"]
	expect(t, ada.json(http.MethodPost, "/shares", map[string]any{
		"vault_id": v, "resource_type": "file", "file_id": kept, "display_name": "Kept",
		"grants": []map[string]any{grantTo("user", bob.userID, "viewer")},
	}), http.StatusCreated)
	mustAccepted(t, ada.commit(v, del(kept, 1))[0])
	e.setRevisionTimes(kept, now.AddDate(0, 0, -120), now.AddDate(0, 0, -100))

	r := e.jobs(now)
	r.PurgeBatch = 1
	n, err := r.PurgeDeletedFiles(ctxBg())
	if err != nil {
		t.Fatal(err)
	}
	if n < len(files) {
		t.Fatalf("purged %d tombstones, want at least %d", n, len(files))
	}
	for _, f := range files {
		if c := e.count(`SELECT COUNT(*) FROM files WHERE id = $1`, f); c != 0 {
			t.Fatalf("tombstone %s survived", f)
		}
	}
	for _, h := range hashes {
		if refs := e.refCount(h); refs != 0 {
			t.Fatalf("ref_count of %s = %d after its revisions were purged", h, refs)
		}
	}
	if c := e.count(`SELECT COUNT(*) FROM files WHERE id = $1`, kept); c != 1 {
		t.Fatal("the tombstone a file share points at was purged")
	}
}

// A vault whose tombstones cannot be purged no longer stops the purge of the
// vaults after it: the failure is reported and the walk goes on.
func TestTombstonePurgeContinuesAfterAFailure(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada-tomb-failure")
	now := time.Now().UTC()
	tombstones := map[string]string{} // vault -> file
	for _, name := range []string{"Tombstones fail", "Tombstones work"} {
		v := ada.createVault(name, "shared")
		f := ada.seed(v, map[string]string{"t.md": "t " + newID()})["t.md"]
		mustAccepted(t, ada.commit(v, del(f, 1))[0])
		e.setRevisionTimes(f, now.AddDate(0, 0, -120), now.AddDate(0, 0, -100))
		tombstones[v] = f
	}
	// The failing vault is the one the keyset walk reaches first.
	var vaultIDs []string
	for v := range tombstones {
		vaultIDs = append(vaultIDs, v)
	}
	slices.Sort(vaultIDs)
	bad, good := vaultIDs[0], vaultIDs[1]
	e.exec(`CREATE FUNCTION test_refuse_file_delete() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'file delete refused by the test'; END; $$ LANGUAGE plpgsql`)
	t.Cleanup(func() { e.exec(`DROP FUNCTION test_refuse_file_delete() CASCADE`) })
	e.exec(fmt.Sprintf(`CREATE TRIGGER test_refuse_file_delete BEFORE DELETE ON files
FOR EACH ROW WHEN (OLD.id = '%s') EXECUTE FUNCTION test_refuse_file_delete()`, tombstones[bad]))

	r := e.jobs(now)
	r.PurgeBatch = 1
	_, err := r.PurgeDeletedFiles(ctxBg())
	if err == nil || !strings.Contains(err.Error(), bad) {
		t.Fatalf("error %v does not report the failed vault", err)
	}
	if c := e.count(`SELECT COUNT(*) FROM files WHERE id = $1`, tombstones[good]); c != 0 {
		t.Fatal("the tombstone of the vault next to a failing one was not purged")
	}
	if c := e.count(`SELECT COUNT(*) FROM files WHERE id = $1`, tombstones[bad]); c != 1 {
		t.Fatal("the tombstone whose delete failed is gone")
	}
	if c := e.count(`SELECT COUNT(*) FROM file_revisions WHERE file_id = $1`, tombstones[bad]); c != 2 {
		t.Fatalf("the failed purge left %d revisions, want both (rolled back)", c)
	}
}

// Regression (M12, purge-vault-one-tx): the purge of a deleted vault ran in
// one unbounded transaction and released blob references one by one in random
// order. It now pages through revisions and files; references shared with
// another vault, file shares and quota come out right.
func TestVaultPurgeInPages(t *testing.T) {
	e := newEnv(t)
	ada, bob := e.user("ada-pages"), e.user("bob-pages")
	v := ada.createVault("Paged purge", "shared")
	keep := ada.createVault("Paged keep", "shared")
	common := []byte("common attachment " + newID())
	hc := ada.putBlob(v, common)
	if ada.putBlob(keep, common) != hc {
		t.Fatal("same content, different hash")
	}
	mustAccepted(t, ada.commit(keep, create(newID(), "c.md", hc))[0])

	var own []string
	blob := func() string {
		h := ada.putBlob(v, []byte("own "+newID()))
		own = append(own, h)
		return h
	}
	f1, f2, f3 := newID(), newID(), newID()
	mustAccepted(t, ada.commit(v, create(f1, "one.md", blob()))[0])
	mustAccepted(t, ada.commit(v, modify(f1, 1, hc))[0])
	mustAccepted(t, ada.commit(v, create(f2, "two.md", blob()))[0])
	mustAccepted(t, ada.commit(v, modify(f2, 1, blob()))[0])
	mustAccepted(t, ada.commit(v, create(f3, "three.md", hc))[0])
	mustAccepted(t, ada.commit(v, del(f3, 1))[0])
	expect(t, ada.json(http.MethodPost, "/shares", map[string]any{
		"vault_id": v, "resource_type": "file", "file_id": f2, "display_name": "Two",
		"grants": []map[string]any{grantTo("user", bob.userID, "viewer")},
	}), http.StatusCreated)
	if refs := e.refCount(hc); refs != 3 {
		t.Fatalf("ref_count of the common blob = %d before the purge, want 3", refs)
	}
	expect(t, ada.json(http.MethodDelete, "/vaults/"+v, nil), http.StatusNoContent)

	r := e.jobs(time.Now().Add(31 * 24 * time.Hour))
	r.PurgeBatch = 2
	n, err := r.PurgeDeletedVaults(ctxBg())
	if err != nil || n < 1 {
		t.Fatalf("purged %d (%v)", n, err)
	}
	for table, col := range map[string]string{"vaults": "id", "files": "vault_id", "file_revisions": "vault_id", "shares": "vault_id", "vault_blobs": "vault_id"} {
		if c := e.count(`SELECT COUNT(*) FROM `+table+` WHERE `+col+` = $1`, v); c != 0 {
			t.Fatalf("%d rows of %s left after the purge", c, table)
		}
	}
	if refs := e.refCount(hc); refs != 1 {
		t.Fatalf("ref_count of the blob the kept vault uses = %d, want 1", refs)
	}
	for _, h := range own {
		if refs := e.refCount(h); refs != 0 {
			t.Fatalf("ref_count of a purged blob = %d", refs)
		}
	}
	usage := decode[map[string]any](t, ada.json(http.MethodGet, "/me/usage", nil))
	if usage["used_bytes"].(float64) != float64(len(common)) {
		t.Fatalf("usage after the purge: %v, want %d", usage, len(common))
	}
}

// The purge checks again, under the vault row lock, that the vault is still
// deleted: a restore that commits between the listing and the lock wins.
func TestVaultPurgeLeavesAVaultRestoredMeanwhile(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada-restored")
	v := ada.createVault("Restored meanwhile", "shared")
	f := ada.seed(v, map[string]string{"r.md": "restored " + newID()})["r.md"]
	expect(t, ada.json(http.MethodDelete, "/vaults/"+v, nil), http.StatusNoContent)
	e.exec(`UPDATE vaults SET deleted_at = now() - interval '40 days' WHERE id = $1`, v)

	// A restore in flight: it holds the vault row.
	ctx := context.Background()
	tx, err := e.db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `UPDATE vaults SET deleted_at = NULL WHERE id = $1`, v); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, err := e.jobs(time.Now()).PurgeDeletedVaults(ctx); done <- err }()
	deadline := time.Now().Add(15 * time.Second)
	for {
		var waiting int
		if err := e.db.Pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%GetVaultForUpdate%'`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting > 0 {
			break
		}
		select {
		case err := <-done:
			t.Fatalf("the purge finished without waiting for the restore (%v)", err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("the purge never waited for the vault row lock")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if c := e.count(`SELECT COUNT(*) FROM file_revisions WHERE file_id = $1`, f); c != 1 {
		t.Fatalf("revisions of the restored vault: %d, want 1", c)
	}
	expect(t, ada.json(http.MethodGet, "/vaults/"+v, nil), http.StatusOK)
}

// Retention locks revisions before the vault row and the purge the other way
// round: a purge that finds the remaining revisions held skips them and is
// postponed (no error, no deadlock, nothing half released), and the next run
// finishes it.
func TestVaultPurgePostponedWhileRevisionsAreHeld(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada-held")
	v := ada.createVault("Held revisions", "shared")
	ids := ada.seed(v, map[string]string{"a.md": "a " + newID(), "b.md": "b " + newID()})
	h := ada.putBlob(v, []byte("held "+newID()))
	mustAccepted(t, ada.commit(v, modify(ids["a.md"], 1, h))[0])
	expect(t, ada.json(http.MethodDelete, "/vaults/"+v, nil), http.StatusNoContent)

	ctx := context.Background()
	tx, err := e.db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT id FROM file_revisions WHERE file_id = $1 FOR UPDATE`, ids["a.md"]); err != nil {
		t.Fatal(err)
	}

	r := e.jobs(time.Now().Add(31 * 24 * time.Hour))
	r.PurgeBatch = 1
	n, err := r.PurgeDeletedVaults(ctxBg())
	if err != nil {
		t.Fatalf("a postponed purge reported an error: %v", err)
	}
	if n != 0 || e.count(`SELECT COUNT(*) FROM vaults WHERE id = $1`, v) != 1 {
		t.Fatalf("purged %d vaults while their revisions were held", n)
	}
	if c := e.count(`SELECT COUNT(*) FROM file_revisions WHERE file_id = $1`, ids["a.md"]); c != 2 {
		t.Fatalf("revisions of the held file: %d, want 2", c)
	}
	if refs := e.refCount(h); refs != 1 {
		t.Fatalf("ref_count of the held revision's blob = %d, want 1", refs)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}

	if n, err := r.PurgeDeletedVaults(ctxBg()); err != nil || n < 1 {
		t.Fatalf("next run purged %d (%v)", n, err)
	}
	if c := e.count(`SELECT COUNT(*) FROM vaults WHERE id = $1`, v); c != 0 {
		t.Fatal("the postponed vault was not purged by the next run")
	}
	if refs := e.refCount(h); refs != 0 {
		t.Fatalf("ref_count after the purge = %d", refs)
	}
}

// A vault whose purge fails no longer stops the purge of the others.
func TestVaultPurgeContinuesAfterAFailure(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada-failure")
	bad := ada.createVault("Purge fails", "shared")
	good := ada.createVault("Purge works", "shared")
	for _, v := range []string{bad, good} {
		ada.seed(v, map[string]string{"x.md": "x " + newID()})
		expect(t, ada.json(http.MethodDelete, "/vaults/"+v, nil), http.StatusNoContent)
	}
	e.exec(`CREATE FUNCTION test_refuse_vault_delete() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'vault delete refused by the test'; END; $$ LANGUAGE plpgsql`)
	t.Cleanup(func() { e.exec(`DROP FUNCTION test_refuse_vault_delete() CASCADE`) })
	e.exec(fmt.Sprintf(`CREATE TRIGGER test_refuse_vault_delete BEFORE DELETE ON vaults
FOR EACH ROW WHEN (OLD.id = '%s') EXECUTE FUNCTION test_refuse_vault_delete()`, bad))

	n, err := e.jobs(time.Now().Add(31 * 24 * time.Hour)).PurgeDeletedVaults(ctxBg())
	if err == nil || !strings.Contains(err.Error(), bad) {
		t.Fatalf("error %v does not report the failed vault", err)
	}
	if n < 1 {
		t.Fatalf("purged %d vaults", n)
	}
	if c := e.count(`SELECT COUNT(*) FROM vaults WHERE id = $1`, good); c != 0 {
		t.Fatal("the vault after a failing one was not purged")
	}
	if c := e.count(`SELECT COUNT(*) FROM vaults WHERE id = $1`, bad); c != 1 {
		t.Fatal("the failing vault is gone")
	}
}
