package perf_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/rs/zerolog"

	"clarae/apps/desktop/internal/indexer"
	"clarae/apps/desktop/internal/links"
	"clarae/apps/desktop/internal/store"
	syncpkg "clarae/apps/desktop/internal/sync"
	"clarae/apps/desktop/internal/sync/transport"
	"clarae/apps/desktop/internal/vault"
	"clarae/shared/hashing"
	"clarae/shared/pathrules"
	"clarae/shared/syncproto"
)

// The phases below mutate the cached dataset and leave it as they found it:
// created notes are deleted again and renames are undone byte for byte, with
// the index brought back in line (the next phases and the next run reuse both).

// noteTitle is the link text of a note path (its base name without extension).
func noteTitle(p string) string { return strings.TrimSuffix(path.Base(p), path.Ext(p)) }

// measureCreateDelete times the index path of a note created and then deleted
// through the app (VaultAPI.WriteNote with an empty hash, VaultAPI.Trash): both
// call Indexer.Update with the path, and both change the file set, so Update
// re-resolves every link of the vault (links.ResolveAll). Only Update is timed.
func measureCreateDelete(ctx context.Context, t *testing.T, out metrics, fsys *vault.FS, ix *indexer.Indexer, paths []string, rng *rand.Rand, samples int) {
	t.Helper()
	var created []string
	t.Cleanup(func() {
		for _, p := range created {
			_ = fsys.Delete(p)
		}
	})
	var create, del []time.Duration
	for i := 0; i < samples; i++ {
		a, b := paths[rng.IntN(len(paths))], paths[rng.IntN(len(paths))]
		body := fmt.Sprintf("# Perf new note %d\n\nSee [[%s]] and [[%s]], and a [[perf ghost %d]].\n", i, noteTitle(a), noteTitle(b), i)
		c, err := fsys.WriteFile(fmt.Sprintf("perf new note %d.md", i), []byte(body), "", true)
		if err != nil {
			t.Fatal(err)
		}
		created = append(created, c.Path)
		s := time.Now()
		if err := ix.Update(ctx, []string{c.Path}); err != nil {
			t.Fatal(err)
		}
		create = append(create, time.Since(s))
	}
	for _, p := range created {
		if err := fsys.Delete(p); err != nil {
			t.Fatal(err)
		}
		s := time.Now()
		if err := ix.Update(ctx, []string{p}); err != nil {
			t.Fatal(err)
		}
		del = append(del, time.Since(s))
	}
	created = nil
	med, p95 := quantiles(create)
	out.set(t, "note_create_index_median_ms", ms(med), fmt.Sprintf("ms (Update after a new note, %d samples)", samples))
	out.set(t, "note_create_index_p95_ms", ms(p95), "ms")
	med, p95 = quantiles(del)
	out.set(t, "note_delete_index_median_ms", ms(med), fmt.Sprintf("ms (Update after a deleted note, %d samples)", samples))
	out.set(t, "note_delete_index_p95_ms", ms(p95), "ms")
}

// backlinkTargets returns the notes with the most incoming links (hubs) and a
// deterministic random pick of notes with one to three (leaves).
func backlinkTargets(ctx context.Context, t *testing.T, db *sql.DB, rng *rand.Rand, n int) (hubs, leaves []string, counts map[string]int) {
	t.Helper()
	rows, err := db.QueryContext(ctx, `
		SELECT target_resolved, count(*) FROM links
		WHERE target_resolved LIKE '%.md' AND target_resolved <> path
		GROUP BY target_resolved ORDER BY count(*) DESC, target_resolved`)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	counts = map[string]int{}
	var few []string
	for rows.Next() {
		var p string
		var c int
		if err := rows.Scan(&p, &c); err != nil {
			t.Fatal(err)
		}
		counts[p] = c
		switch {
		case len(hubs) < n:
			hubs = append(hubs, p)
		case c <= 3:
			few = append(few, p)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	sort.Strings(few)
	for len(leaves) < n && len(few) > 0 {
		i := rng.IntN(len(few))
		leaves = append(leaves, few[i])
		few = append(few[:i], few[i+1:]...)
	}
	return hubs, leaves, counts
}

func renamedPath(p string) string {
	return path.Join(path.Dir(p), noteTitle(p)+" perf renamed"+path.Ext(p))
}

// measureRename times the rename preview (links.PlanRename, what LinksAPI.PlanRename
// does) of hub and leaf notes, then one real rename of each kind as LinksAPI.ApplyRename
// does it (plan again, rewrite, move, Indexer.Update of the touched paths) of a note with
// about 100 backlinks and of a leaf, each undone afterwards.
func measureRename(ctx context.Context, t *testing.T, out metrics, fsys *vault.FS, db *sql.DB, ix *indexer.Indexer, rng *rand.Rand, samples int) {
	t.Helper()
	hubs, leaves, counts := backlinkTargets(ctx, t, db, rng, samples)
	if len(hubs) == 0 || len(leaves) == 0 {
		t.Fatalf("rename: no candidate notes (hubs %d, leaves %d)", len(hubs), len(leaves))
	}
	plan := func(kind string, notes []string) {
		var ds []time.Duration
		edits := 0
		for _, p := range notes {
			s := time.Now()
			pl, err := links.PlanRename(ctx, db, fsys, p, renamedPath(p))
			if err != nil {
				t.Fatal(err)
			}
			ds = append(ds, time.Since(s))
			edits += len(pl.Files)
		}
		med, _ := quantiles(ds)
		out.set(t, "plan_rename_"+kind+"_median_ms", ms(med), fmt.Sprintf("ms (%d notes, %.0f notes rewritten on average)", len(notes), float64(edits)/float64(len(notes))))
	}
	plan("hub", hubs)
	plan("leaf", leaves)
	t.Logf("rename: hub backlinks %d..%d, leaf backlinks %d..%d", counts[hubs[len(hubs)-1]], counts[hubs[0]], minCount(counts, leaves), maxCount(counts, leaves))

	apply := func(kind, from string) {
		to := renamedPath(from)
		preview, err := links.PlanRename(ctx, db, fsys, from, to)
		if err != nil {
			t.Fatal(err)
		}
		// Original bytes of every note the rename rewrites (at its path before the move).
		saved := map[string][]byte{}
		for _, fe := range preview.Files {
			c, err := fsys.ReadFile(fe.Path)
			if err != nil {
				t.Fatal(err)
			}
			saved[fe.Path] = c.Data
		}
		s := time.Now()
		pl, err := links.PlanRename(ctx, db, fsys, from, to)
		if err != nil {
			t.Fatal(err)
		}
		if err := links.ApplyRename(fsys, pl); err != nil {
			t.Fatal(err)
		}
		touched := []string{pl.From, pl.To}
		for _, f := range pl.Files {
			touched = append(touched, f.Path)
		}
		if err := ix.Update(ctx, touched); err != nil {
			t.Fatal(err)
		}
		out.set(t, "apply_rename_"+kind+"ms", ms(time.Since(s)), fmt.Sprintf("ms (1 sample, %d backlinks, %d notes rewritten; re-plan + rewrite + move + Update)", counts[from], len(pl.Files)))
		for _, f := range pl.Files {
			if _, ok := saved[f.Path]; !ok {
				t.Fatalf("rename: %s rewritten but not in the preview", f.Path)
			}
		}

		// Undo: move back, restore the original bytes, refresh the index.
		if err := fsys.Rename(to, from); err != nil {
			t.Fatal(err)
		}
		for p, data := range saved {
			c, err := fsys.WriteFile(p, data, "", false)
			if err != nil {
				t.Fatal(err)
			}
			if c.Hash != hashing.Sum(data).Hex() {
				t.Fatalf("rename undo: %s not restored", p)
			}
		}
		if err := ix.Update(ctx, touched); err != nil {
			t.Fatal(err)
		}
	}
	// A real rename of a top hub rewrites thousands of notes at 50k (and as many again to
	// undo it): the apply step uses a note with about 100 backlinks instead.
	mid := hubs[0]
	for p, c := range counts {
		if d, best := absInt(c-100), absInt(counts[mid]-100); d < best || (d == best && p < mid) {
			mid = p
		}
	}
	apply("", mid)
	apply("leaf_", leaves[0])
}

func absInt(v int) int { return max(v, -v) }

func minCount(counts map[string]int, ps []string) int {
	m := counts[ps[0]]
	for _, p := range ps {
		m = min(m, counts[p])
	}
	return m
}

func maxCount(counts map[string]int, ps []string) int {
	m := counts[ps[0]]
	for _, p := range ps {
		m = max(m, counts[p])
	}
	return m
}

// idleRemote is a server with nothing new: the changelog is empty and any
// other call fails the cycle. It records when the engine first asked for
// changes, which is right after the local scan.
type idleRemote struct {
	firstChanges atomic.Int64 // UnixNano, 0 until the first Changes call of a cycle
}

var errUnexpectedRemote = errors.New("perf: unexpected remote call")

func (r *idleRemote) Tree(context.Context) (transport.Tree, error) {
	return transport.Tree{}, errUnexpectedRemote
}

func (r *idleRemote) Changes(_ context.Context, since int64, _ string, _ int) (transport.Changes, error) {
	r.firstChanges.CompareAndSwap(0, time.Now().UnixNano())
	return transport.Changes{NextSeq: since}, nil
}

func (r *idleRemote) CheckBlobs(context.Context, []string) ([]string, error) {
	return nil, errUnexpectedRemote
}

func (r *idleRemote) Upload(context.Context, string, []byte, string) (string, error) {
	return "", errUnexpectedRemote
}

func (r *idleRemote) Download(context.Context, string, io.Writer) error { return errUnexpectedRemote }

func (r *idleRemote) RevisionContent(context.Context, string, int, io.Writer) error {
	return errUnexpectedRemote
}

func (r *idleRemote) Commit(context.Context, syncproto.CommitRequest) (syncproto.CommitResponse, error) {
	return syncproto.CommitResponse{}, errUnexpectedRemote
}

// measureSyncScan times the local scan of a synchronized vault in which
// nothing changed. sync.db (in a temporary directory) gets one synced row per
// file and the start time of the scan that recorded them, as after a completed
// sync; then a new Engine (as after an app start)
// runs a cycle against a server with nothing to send, twice. The scan is the
// time from Sync to the first changelog request; the whole cycle is logged.
func measureSyncScan(ctx context.Context, t *testing.T, out metrics, fsys *vault.FS) {
	t.Helper()
	dir := t.TempDir()
	sdb, err := store.Open(ctx, filepath.Join(dir, "sync.db"), store.KindSync)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = sdb.Close() }()
	sd := syncpkg.NewDB(sdb)

	start := time.Now()
	var rows []syncpkg.File
	if err := fsys.Walk(func(e vault.Entry) error {
		if e.IsDir || pathrules.IsExcluded(e.Path, true) {
			return nil
		}
		h, _, err := fsys.HashFile(e.Path)
		if err != nil {
			return err
		}
		rows = append(rows, syncpkg.File{
			Path: e.Path, FileID: uuid.NewString(), ServerRev: 1, BaseRev: 1, ServerHash: h,
			LocalHash: h, LocalSize: e.Size, LocalMtime: e.Mtime.UnixNano(), State: syncpkg.StateSynced,
		})
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := sd.WithTx(ctx, func(tx *syncpkg.DB) error {
		for _, r := range rows {
			if err := tx.PutFile(ctx, r); err != nil {
				return err
			}
		}
		// The rows were observed after start: a scan that began then would have stored it.
		if err := tx.SetMeta(ctx, syncpkg.MetaLastScan, strconv.FormatInt(start.UnixNano(), 10)); err != nil {
			return err
		}
		return tx.SetMeta(ctx, syncpkg.MetaBootstrapped, "1")
	}); err != nil {
		t.Fatal(err)
	}
	t.Logf("sync: %d synced rows prepared (%s, not timed)", len(rows), time.Since(start).Round(time.Millisecond))
	// The first cycle of an engine also sweeps stale staging files (one more walk of the vault).
	start = time.Now()
	if _, err := fsys.CleanStaleTemp(time.Minute); err != nil {
		t.Fatal(err)
	}
	t.Logf("sync: stale temp sweep alone %s (part of the first cycle only)", time.Since(start).Round(time.Millisecond))

	remote := &idleRemote{}
	eng := syncpkg.New(syncpkg.Config{
		LocalID: "perf", FS: fsys, DB: sd, Remote: remote, DeviceID: "perf-device",
		CacheDir: filepath.Join(dir, "outbox"), Logger: zerolog.Nop(),
	})
	cycle := func(name string) {
		remote.firstChanges.Store(0)
		s := time.Now()
		if err := eng.Sync(ctx); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		total := time.Since(s)
		first := remote.firstChanges.Load()
		if first == 0 {
			t.Fatalf("%s: the engine never asked for changes", name)
		}
		if n, err := sd.PendingCount(ctx); err != nil || n != 0 {
			t.Fatalf("%s: %d files pending after a cycle on an unchanged vault (%v)", name, n, err)
		}
		out.set(t, name, time.Unix(0, first).Sub(s).Seconds(), fmt.Sprintf("s (scan of %d files; whole cycle %.2f s)", len(rows), total.Seconds()))
	}
	cycle("sync_first_scan_s")
	cycle("sync_rescan_unchanged_s")
}
