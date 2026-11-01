//go:build integration

package integration

import (
	"context"
	"fmt"
	"net/http"
	"slices"
	"testing"
	"time"

	"memobrain/shared/syncproto"
)

// dayAt is hour h (UTC) of the day daysAgo days before now.
func dayAt(now time.Time, daysAgo, h int) time.Time {
	d := now.AddDate(0, 0, -daysAgo)
	return time.Date(d.Year(), d.Month(), d.Day(), h, 0, 0, 0, time.UTC)
}

// setRevisionTimes places the revisions of a file in time: times[i] is rev i+1.
func (e *env) setRevisionTimes(fileID string, times ...time.Time) {
	e.t.Helper()
	for i, ts := range times {
		e.exec(`UPDATE file_revisions SET server_time = $1 WHERE file_id = $2 AND rev_no = $3`, ts, fileID, i+1)
	}
}

// revNos lists the revisions of a file still stored, oldest first.
func (e *env) revNos(fileID string) []int {
	e.t.Helper()
	rows, err := e.db.Pool.Query(ctxBg(), `SELECT rev_no FROM file_revisions WHERE file_id = $1 ORDER BY rev_no`, fileID)
	if err != nil {
		e.t.Fatal(err)
	}
	defer rows.Close()
	var out []int
	for rows.Next() {
		var n int
		if err := rows.Scan(&n); err != nil {
			e.t.Fatal(err)
		}
		out = append(out, n)
	}
	return out
}

// Regression (A1): a conflict copy references the revision of the original it
// was derived from; once that revision was no longer current, pruning it broke
// the foreign key and the whole retention batch rolled back on every run.
func TestRetentionPrunesARevisionAConflictCopyPointsAt(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createVault("Conflict retention", "shared")
	h1 := ada.putBlob(v, []byte("original "+newID()))
	h2 := ada.putBlob(v, []byte("theirs "+newID()))
	h3 := ada.putBlob(v, []byte("edited "+newID()))
	orig, cp := newID(), newID()
	first := mustAccepted(t, ada.commit(v, create(orig, "a.md", h1))[0])
	c := create(cp, "a (conflict).md", h2)
	c["conflict_of"] = orig
	mustAccepted(t, ada.commit(v, c)[0]) // points at rev 1 of a.md
	mustAccepted(t, ada.commit(v, modify(orig, 1, h3))[0])

	now := time.Now().UTC()
	e.setRevisionTimes(orig, now.AddDate(0, 0, -100))
	if _, err := e.jobs(now).PruneRevisions(ctxBg()); err != nil {
		t.Fatalf("retention failed on a revision referenced by a conflict copy: %v", err)
	}
	if got := e.revNos(orig); !slices.Equal(got, []int{2}) {
		t.Fatalf("revisions of the original: %v, want [2]", got)
	}
	// The changelog still names the original of the copy.
	items, _, _ := ada.changes(v, first.seq())
	found := false
	for _, it := range items {
		if it["file_id"] == cp {
			found = true
			if it["conflict_of"] != orig {
				t.Fatalf("conflict copy entry lost its original: %v", it)
			}
		}
	}
	if !found {
		t.Fatalf("conflict copy missing from the changelog: %v", items)
	}

	// Purging the vault removes copies and originals together.
	c2 := create(newID(), "a (conflict 2).md", h2)
	c2["conflict_of"] = orig
	mustAccepted(t, ada.commit(v, c2)[0])
	expect(t, ada.json(http.MethodDelete, "/vaults/"+v, nil), http.StatusNoContent)
	if _, err := e.jobs(now.Add(31 * 24 * time.Hour)).PurgeDeletedVaults(ctxBg()); err != nil {
		t.Fatalf("purge of a vault with conflict copies: %v", err)
	}
	var left int
	if err := e.db.Pool.QueryRow(ctxBg(), `SELECT count(*) FROM file_revisions WHERE vault_id = $1`, v).Scan(&left); err != nil || left != 0 {
		t.Fatalf("revisions left after purge: %d (%v)", left, err)
	}
}

// Regression (A2): retention deleted changelog entries inside the changelog
// window without advancing the compaction point, so a client behind a pruned
// move never learnt about it and kept the old path.
func TestRetentionExpiresCursorsBeforeAPrunedMove(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	now := time.Now().UTC()
	var hs []string
	v := ada.createVault("Pruned move", "shared")
	for i := 0; i < 4; i++ {
		hs = append(hs, ada.putBlob(v, []byte(fmt.Sprintf("content %d %s", i, newID()))))
	}
	f := newID()
	created := mustAccepted(t, ada.commit(v, create(f, "a.md", hs[0]))[0])
	moved := mustAccepted(t, ada.commit(v, move(f, 1, "b.md"))[0])
	mustAccepted(t, ada.commit(v, modify(f, 2, hs[1]))[0])
	mustAccepted(t, ada.commit(v, modify(f, 3, hs[2]))[0])
	// Create and move are superseded on their day (pruned), the modify after them is the last of the day.
	e.setRevisionTimes(f, dayAt(now, 40, 1), dayAt(now, 40, 2), dayAt(now, 40, 3), now)

	// A vault where retention drops only a superseded content change.
	w := ada.createVault("Pruned modify", "shared")
	var ws []string
	for i := 0; i < 4; i++ {
		ws = append(ws, ada.putBlob(w, []byte(fmt.Sprintf("other %d %s", i, newID()))))
	}
	g := newID()
	mustAccepted(t, ada.commit(w, create(g, "c.md", ws[0]))[0])
	prunedModify := mustAccepted(t, ada.commit(w, modify(g, 1, ws[1]))[0])
	mustAccepted(t, ada.commit(w, modify(g, 2, ws[2]))[0])
	mustAccepted(t, ada.commit(w, modify(g, 3, ws[3]))[0])
	e.setRevisionTimes(g, dayAt(now, 45, 12), dayAt(now, 40, 1), dayAt(now, 40, 2), now)

	if _, err := e.jobs(now).PruneRevisions(ctxBg()); err != nil {
		t.Fatal(err)
	}
	if got := e.revNos(f); !slices.Equal(got, []int{3, 4}) {
		t.Fatalf("revisions of the moved file: %v, want [3 4]", got)
	}
	// A client that saw the create but not the move must bootstrap.
	resp := ada.json(http.MethodGet, fmt.Sprintf("/vaults/%s/changes?since=%d", v, created.seq()), nil)
	expect(t, resp, http.StatusGone)
	if p := decode[syncproto.Problem](t, resp); p.Code != syncproto.CodeCursorExpired {
		t.Fatalf("code %s", p.Code)
	}
	// One that saw the move continues.
	if items, _, _ := ada.changes(v, moved.seq()); len(items) != 2 {
		t.Fatalf("items after the pruned move: %d, want 2", len(items))
	}

	// The pruned modify is superseded by the later revisions: no cursor expires.
	if got := e.revNos(g); !slices.Equal(got, []int{1, 3, 4}) {
		t.Fatalf("revisions of the modified file: %v, want [1 3 4]", got)
	}
	items, _, _ := ada.changes(w, 0)
	for _, it := range items {
		if int64(it["seq"].(float64)) == prunedModify.seq() {
			t.Fatalf("pruned revision still served: %v", it)
		}
	}
	if len(items) != 3 {
		t.Fatalf("changes of the vault with a pruned modify: %d, want 3", len(items))
	}
}

// Regression (retention-batch-stall): a page of candidates that all survived
// ended the run, so the files after more than one page of daily survivors
// were never pruned. Also checks that a day split across pages keeps exactly
// its last revision.
func TestRetentionPagesPastSurvivors(t *testing.T) {
	e := newEnv(t)
	e.app.Revisions.RetentionBatch = 2
	ada := e.user("ada")
	v := ada.createVault("Retention pages", "shared")
	now := time.Now().UTC()
	blob := func() string { return ada.putBlob(v, []byte("rev "+newID())) }

	// Four daily survivors, more than one page.
	survivors := newID()
	mustAccepted(t, ada.commit(v, create(survivors, "s.md", blob()))[0])
	for rev := 1; rev <= 4; rev++ {
		mustAccepted(t, ada.commit(v, modify(survivors, rev, blob()))[0])
	}
	e.setRevisionTimes(survivors, dayAt(now, 60, 12), dayAt(now, 59, 12), dayAt(now, 58, 12), dayAt(now, 57, 12), now)

	// Three revisions on one day, necessarily split across pages of two.
	sameDay := newID()
	mustAccepted(t, ada.commit(v, create(sameDay, "d.md", blob()))[0])
	for rev := 1; rev <= 3; rev++ {
		mustAccepted(t, ada.commit(v, modify(sameDay, rev, blob()))[0])
	}
	e.setRevisionTimes(sameDay, dayAt(now, 50, 1), dayAt(now, 50, 2), dayAt(now, 50, 3), now)

	// A file after them with a revision beyond the daily window.
	late := newID()
	mustAccepted(t, ada.commit(v, create(late, "z.md", blob()))[0])
	mustAccepted(t, ada.commit(v, modify(late, 1, blob()))[0])
	e.setRevisionTimes(late, now.AddDate(0, 0, -100), now)

	if _, err := e.jobs(now).PruneRevisions(ctxBg()); err != nil {
		t.Fatal(err)
	}
	if got := e.revNos(survivors); !slices.Equal(got, []int{1, 2, 3, 4, 5}) {
		t.Fatalf("daily survivors: %v, want all five", got)
	}
	if got := e.revNos(sameDay); !slices.Equal(got, []int{3, 4}) {
		t.Fatalf("same-day revisions: %v, want [3 4]", got)
	}
	if got := e.revNos(late); !slices.Equal(got, []int{2}) {
		t.Fatalf("file after the survivors: %v, want [2] (retention stalled)", got)
	}
}

// Regression (reconcile-stale-overwrite): reconciliation computed the totals
// from one snapshot and wrote them as absolute values, overwriting a commit
// that landed in between. It now locks the vault row (as a commit does) and
// recomputes after the lock, so the commit's change is part of the result.
func TestReconcileUsageKeepsAConcurrentCommit(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createVault("Reconcile race", "shared")
	content := []byte("reconciled " + newID())
	h := ada.putBlob(v, content)
	f := newID()
	mustAccepted(t, ada.commit(v, create(f, "r.md", h))[0])
	e.exec(`UPDATE vaults SET total_bytes = 999 WHERE id = $1`, v) // drift to correct

	// A commit in flight: it holds the vault row and has changed a file and the counter.
	ctx := context.Background()
	tx, err := e.db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `UPDATE vaults SET total_bytes = total_bytes + 100 WHERE id = $1`, v); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE files SET size = size + 100 WHERE id = $1`, f); err != nil {
		t.Fatal(err)
	}

	done := make(chan error, 1)
	go func() { done <- e.jobs(time.Now()).ReconcileUsage(ctx) }()
	// Wait until reconciliation is blocked on the vault row lock.
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
			t.Fatalf("reconciliation finished without waiting for the commit (%v)", err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("reconciliation never waited for the vault row lock")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	var total int64
	if err := e.db.Pool.QueryRow(ctx, `SELECT total_bytes FROM vaults WHERE id = $1`, v).Scan(&total); err != nil {
		t.Fatal(err)
	}
	if want := int64(len(content)) + 100; total != want {
		t.Fatalf("total_bytes = %d, want %d: the concurrent change was overwritten", total, want)
	}
}
