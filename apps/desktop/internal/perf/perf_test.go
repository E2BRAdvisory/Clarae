// Package perf measures the non-functional targets of Appendix A that can be
// checked headlessly on the Go side (indexing, search, note open path, vault
// open, graph build, index memory). It is a test harness, not a unit test: it
// only runs when NODUS_PERF_NOTES is set (see `make perf`).
//
//	NODUS_PERF_NOTES=50000 NODUS_PERF_OUT=perf.json go test -run TestPerf -timeout 60m -v ./internal/perf/
//
// Environment:
//
//	NODUS_PERF_NOTES        notes of the main vault (required to run)
//	NODUS_PERF_DIR          cache directory for generated vaults (default: <user cache>/nodus-perf)
//	NODUS_PERF_GRAPH_NOTES  notes of the graph vault (default 10000, 0 = skip)
//	NODUS_PERF_OUT          write the metrics as JSON to this file
//	NODUS_PERF_CPUPROFILE   write a CPU profile of the search phase
//	NODUS_PERF_KEEP_INDEX   reuse an existing index.db instead of rebuilding it
package perf_test

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"runtime"
	"runtime/pprof"
	"sort"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"nodus/apps/desktop/internal/graph"
	"nodus/apps/desktop/internal/indexer"
	"nodus/apps/desktop/internal/links"
	"nodus/apps/desktop/internal/parser"
	"nodus/apps/desktop/internal/perf/dataset"
	"nodus/apps/desktop/internal/search"
	"nodus/apps/desktop/internal/store"
	"nodus/apps/desktop/internal/vault"
)

type metrics map[string]float64

func (m metrics) set(t *testing.T, name string, v float64, unit string) {
	t.Helper()
	m[name] = round(v)
	t.Logf("%-36s %12.2f %s", name, v, unit)
}

func round(v float64) float64 { return float64(int64(v*100+0.5)) / 100 }

func ms(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }

func quantiles(ds []time.Duration) (median, p95 time.Duration) {
	s := append([]time.Duration(nil), ds...)
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	return s[len(s)/2], s[min(len(s)-1, len(s)*95/100)]
}

func cacheDir(t *testing.T) string {
	if d := os.Getenv("NODUS_PERF_DIR"); d != "" {
		return d
	}
	base, err := os.UserCacheDir()
	if err != nil {
		base = t.TempDir()
	}
	return filepath.Join(base, "nodus-perf")
}

// peakSampler tracks the maximum Go runtime footprint (Sys) while running.
type peakSampler struct {
	peak atomic.Uint64
	stop chan struct{}
}

func startPeak() *peakSampler {
	p := &peakSampler{stop: make(chan struct{})}
	go func() {
		var ms runtime.MemStats
		for {
			runtime.ReadMemStats(&ms)
			if ms.Sys > p.peak.Load() {
				p.peak.Store(ms.Sys)
			}
			select {
			case <-p.stop:
				return
			case <-time.After(100 * time.Millisecond):
			}
		}
	}()
	return p
}

func (p *peakSampler) finish() float64 { close(p.stop); return float64(p.peak.Load()) / (1 << 20) }

func TestPerf(t *testing.T) {
	notesEnv := os.Getenv("NODUS_PERF_NOTES")
	if notesEnv == "" {
		t.Skip("set NODUS_PERF_NOTES to run the performance suite")
	}
	notes, _ := strconv.Atoi(notesEnv)
	ctx := context.Background()
	out := metrics{}
	root := filepath.Join(cacheDir(t), fmt.Sprintf("vault-%d", notes))

	genStart := time.Now()
	man, err := dataset.Ensure(root, dataset.Config{Notes: notes, Seed: 1})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("dataset: %d notes, %.1f MB, %d links (%s)", man.Notes, float64(man.Bytes)/1e6, man.Links, time.Since(genStart).Round(time.Millisecond))
	out.set(t, "dataset_notes", float64(man.Notes), "notes")
	out.set(t, "dataset_mb", float64(man.Bytes)/1e6, "MB")

	indexPath := filepath.Join(root, ".nodus", "index.db")
	if os.Getenv("NODUS_PERF_KEEP_INDEX") == "" {
		if err := store.Reset(indexPath); err != nil {
			t.Fatal(err)
		}
	}

	fsys, err := vault.NewFS(root)
	if err != nil {
		t.Fatal(err)
	}
	db, err := store.Open(ctx, indexPath, store.KindIndex)
	if err != nil {
		t.Fatal(err)
	}

	// 1. Cold full index.
	runtime.GC()
	peak := startPeak()
	if prof := os.Getenv("NODUS_PERF_INDEX_PROFILE"); prof != "" {
		f, err := os.Create(prof)
		if err != nil {
			t.Fatal(err)
		}
		if err := pprof.StartCPUProfile(f); err != nil {
			t.Fatal(err)
		}
		defer func() { _ = f.Close() }()
	}
	start := time.Now()
	if err := indexer.New(fsys, db, zerolog.Nop(), nil).Full(ctx); err != nil {
		t.Fatal(err)
	}
	took := time.Since(start)
	if os.Getenv("NODUS_PERF_INDEX_PROFILE") != "" {
		pprof.StopCPUProfile()
	}
	out.set(t, "index_full_s", took.Seconds(), "s (target < 180 for 50k)")
	out.set(t, "index_full_peak_sys_mb", peak.finish(), "MB Go runtime Sys peak")
	_, _ = db.ExecContext(ctx, `PRAGMA wal_checkpoint(TRUNCATE)`)
	if st, err := os.Stat(indexPath); err == nil {
		out.set(t, "index_db_mb", float64(st.Size())/(1<<20), "MB on disk")
	}
	runtime.GC()
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	out.set(t, "heap_after_index_mb", float64(mem.HeapInuse)/(1<<20), "MB heap in use after GC")

	// 2. Reconcile of an unchanged vault (what a watcher "reconcile" or vault open does in the background).
	start = time.Now()
	if err := indexer.New(fsys, db, zerolog.Nop(), nil).Full(ctx); err != nil {
		t.Fatal(err)
	}
	out.set(t, "reconcile_unchanged_s", time.Since(start).Seconds(), "s")

	// 3. Incremental: rewrite a note and Update it (the path taken after every save).
	rng := rand.New(rand.NewPCG(7, 7)) //nolint:gosec // deterministic sampling
	ix := indexer.New(fsys, db, zerolog.Nop(), nil)
	var paths []string
	if err := fsys.Walk(func(e vault.Entry) error {
		if !e.IsDir && len(paths) < notes {
			paths = append(paths, e.Path)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	var inc []time.Duration
	for i := 0; i < 40; i++ {
		p := paths[rng.IntN(len(paths))]
		c, err := fsys.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := fsys.WriteFile(p, append(c.Data, []byte(fmt.Sprintf("\nedit %d [[extra link %d]]\n", i, i))...), c.Hash, false); err != nil {
			t.Fatal(err)
		}
		s := time.Now()
		if err := ix.Update(ctx, []string{p}); err != nil {
			t.Fatal(err)
		}
		inc = append(inc, time.Since(s))
	}
	med, p95 := quantiles(inc)
	out.set(t, "index_incremental_median_ms", ms(med), "ms per saved note (target < 100)")
	out.set(t, "index_incremental_p95_ms", ms(p95), "ms")
	_ = db.Close()

	// 4. Vault open to "usable" on an existing index: open stores, list the tree,
	// confirm the index answers (the app reconciles in the background).
	runtime.GC()
	start = time.Now()
	fsys2, err := vault.NewFS(root)
	if err != nil {
		t.Fatal(err)
	}
	db, err = store.Open(ctx, indexPath, store.KindIndex)
	if err != nil {
		t.Fatal(err)
	}
	tOpen := time.Since(start)
	tree, err := fsys2.ListTree()
	if err != nil {
		t.Fatal(err)
	}
	tTree := time.Since(start) - tOpen
	var nfiles int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM files`).Scan(&nfiles); err != nil {
		t.Fatal(err)
	}
	eng := search.New(db)
	usable := time.Since(start)
	out.set(t, "vault_open_stores_ms", ms(tOpen), "ms (store.Open + migrations)")
	out.set(t, "vault_open_tree_ms", ms(tTree), fmt.Sprintf("ms (%d entries)", len(tree)))
	out.set(t, "vault_open_usable_ms", ms(usable), "ms (open stores + tree + index ready; target < 3000 whole app, this is the Go part)")
	defer func() { _ = db.Close() }()

	// 5. Search.
	if prof := os.Getenv("NODUS_PERF_CPUPROFILE"); prof != "" {
		f, err := os.Create(prof)
		if err != nil {
			t.Fatal(err)
		}
		if err := pprof.StartCPUProfile(f); err != nil {
			t.Fatal(err)
		}
		defer func() { pprof.StopCPUProfile(); _ = f.Close() }()
	}
	// Cold start of the search cache (the app does it in the background after the first index pass).
	runtime.GC()
	var before runtime.MemStats
	runtime.ReadMemStats(&before)
	start = time.Now()
	if err := eng.Warm(ctx); err != nil {
		t.Fatal(err)
	}
	out.set(t, "search_cache_warm_ms", ms(time.Since(start)), "ms (once per vault open, background)")
	runtime.GC()
	var after runtime.MemStats
	runtime.ReadMemStats(&after)
	out.set(t, "search_cache_heap_mb", float64(after.HeapInuse-min(after.HeapInuse, before.HeapInuse))/(1<<20), "MB of heap held by the cache")

	// Data driven picks keep the queries meaningful at every dataset size.
	var topTag, rareWord string
	if err := db.QueryRowContext(ctx, `SELECT name FROM tags GROUP BY name ORDER BY count(*) DESC, name LIMIT 1`).Scan(&topTag); err != nil {
		t.Fatal(err)
	}
	rareWord = rarestTitleWord(paths[len(paths)/2])
	queries := []struct{ name, q string }{
		{"text_two_words", "budget review"},
		{"text_phrase", `"roadmap invoice"`},
		{"rare_term", rareWord},
		{"tag_and_text", "tag:" + topTag + " plan"},
		{"property_and_text", "[status:active] [amount:<100] risk"},
		{"line_operator", "line:(client invoice)"},
		{"file_operator", "file:budget -idea"},
		{"regex", `/\bproject \w+ 12\d\b/`},
	}
	for _, q := range queries {
		var ds []time.Duration
		var total int
		for i := 0; i < 8; i++ {
			s := time.Now()
			res, err := eng.Query(ctx, q.q, search.Options{})
			if err != nil {
				t.Fatalf("%s: %v", q.q, err)
			}
			total = res.Total
			if i > 0 { // the first run warms the page cache
				ds = append(ds, time.Since(s))
			}
		}
		m, p := quantiles(ds)
		out.set(t, "search_"+q.name+"_median_ms", ms(m), fmt.Sprintf("ms (%d hits)", total))
		out.set(t, "search_"+q.name+"_p95_ms", ms(p), "ms")
	}

	// 6. Note open path, backend part: read + parse + links from the index.
	var open, mentions []time.Duration
	for i := 0; i < 200; i++ {
		p := paths[rng.IntN(len(paths))]
		s := time.Now()
		c, err := fsys2.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		_ = parser.Parse(p, c.Data)
		if _, err := links.Outgoing(ctx, db, p); err != nil {
			t.Fatal(err)
		}
		if _, err := links.Backlinks(ctx, db, p); err != nil {
			t.Fatal(err)
		}
		open = append(open, time.Since(s))
		if i%4 == 0 {
			s = time.Now()
			if _, err := links.UnlinkedMentions(ctx, db, p); err != nil {
				t.Fatal(err)
			}
			mentions = append(mentions, time.Since(s))
		}
	}
	med, p95 = quantiles(open)
	out.set(t, "note_open_median_ms", ms(med), "ms (read+parse+outgoing+backlinks; target < 150)")
	out.set(t, "note_open_p95_ms", ms(p95), "ms")
	med, p95 = quantiles(mentions)
	out.set(t, "unlinked_mentions_median_ms", ms(med), "ms (lazy, shown after the note)")
	out.set(t, "unlinked_mentions_p95_ms", ms(p95), "ms")

	// 7. Graph build on the 10k vault.
	if gn := graphNotes(); gn > 0 {
		measureGraph(ctx, t, out, gn)
	}

	if dest := os.Getenv("NODUS_PERF_OUT"); dest != "" {
		out["notes"] = float64(notes)
		raw, _ := json.MarshalIndent(out, "", "  ")
		if err := os.WriteFile(dest, append(raw, '\n'), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

// rarestTitleWord returns the first word of a note's file name (a random pseudo word).
func rarestTitleWord(p string) string {
	base := filepath.Base(p)
	for i, r := range base {
		if r == ' ' {
			return base[:i]
		}
	}
	return base
}

func graphNotes() int {
	if v := os.Getenv("NODUS_PERF_GRAPH_NOTES"); v != "" {
		n, _ := strconv.Atoi(v)
		return n
	}
	return 10000
}

func measureGraph(ctx context.Context, t *testing.T, out metrics, n int) {
	root := filepath.Join(cacheDir(t), fmt.Sprintf("vault-%d", n))
	if _, err := dataset.Ensure(root, dataset.Config{Notes: n, Seed: 1}); err != nil {
		t.Fatal(err)
	}
	indexPath := filepath.Join(root, ".nodus", "index.db")
	if os.Getenv("NODUS_PERF_KEEP_INDEX") == "" {
		if err := store.Reset(indexPath); err != nil {
			t.Fatal(err)
		}
	}
	fsys, err := vault.NewFS(root)
	if err != nil {
		t.Fatal(err)
	}
	db, err := store.Open(ctx, indexPath, store.KindIndex)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	start := time.Now()
	if err := indexer.New(fsys, db, zerolog.Nop(), nil).Full(ctx); err != nil {
		t.Fatal(err)
	}
	out.set(t, fmt.Sprintf("index_full_%dk_s", n/1000), time.Since(start).Seconds(), "s")
	opts := graph.Options{ShowOrphans: true, ShowGhosts: true, ShowTags: true, MaxNodes: 1 << 30}
	var ds []time.Duration
	var g graph.Graph
	for i := 0; i < 5; i++ {
		s := time.Now()
		if g, err = graph.Build(ctx, db, opts); err != nil {
			t.Fatal(err)
		}
		ds = append(ds, time.Since(s))
	}
	med, _ := quantiles(ds)
	out.set(t, fmt.Sprintf("graph_build_%dk_median_ms", n/1000), ms(med), fmt.Sprintf("ms (%d nodes, %d edges)", len(g.Nodes), len(g.Edges)))
}
