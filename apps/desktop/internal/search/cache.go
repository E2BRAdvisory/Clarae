package search

import (
	"context"
	"database/sql"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
)

// DefaultCacheBudget bounds the note text kept in memory by the candidate
// cache (bytes of indexed body text). Above it the engine falls back to
// streaming the bodies out of index.db on every query (correct, slower).
const DefaultCacheBudget int64 = 512 << 20

// The candidate cache (M7-WP1, ADR-0020). A query used to read every candidate
// body from SQLite; at 50,000 notes that is about 170 MB of page reads and
// copies per query. The cache keeps, per index database, the file list with
// titles, bodies and lower-cased tags in memory, in path order, and refreshes
// itself incrementally: a cheap fingerprint of the files table tells whether
// anything changed and only the rows whose (id, indexed_at) differ are reloaded.
// Evaluation is the very same code as the streaming path, so results are
// identical; it only runs on all cores.

type cachedFile struct {
	id        int64
	meta      fileMeta
	indexedAt string
	body      string
	tags      []string // lower-cased
}

type snapshot struct {
	fp    fingerprint
	files []cachedFile // sorted by path
	bytes int64
	// tooBig: the text of the vault exceeds the budget, nothing is cached.
	tooBig bool
}

type fingerprint struct {
	count     int64
	maxStamp  string
	textBytes int64
}

type cache struct {
	mu     sync.Mutex
	snap   *snapshot
	budget atomic.Int64
}

var caches sync.Map // *sql.DB -> *cache

func cacheFor(db *sql.DB) *cache {
	if c, ok := caches.Load(db); ok {
		return c.(*cache)
	}
	c := &cache{}
	c.budget.Store(DefaultCacheBudget)
	actual, _ := caches.LoadOrStore(db, c)
	return actual.(*cache)
}

// Forget drops the cache of a database that is being closed.
func Forget(db *sql.DB) { caches.Delete(db) }

// SetCacheBudget changes the number of body bytes cached for this index; 0 or
// less disables the cache.
func (e *Engine) SetCacheBudget(n int64) {
	e.c.budget.Store(n)
	e.c.mu.Lock()
	e.c.snap = nil
	e.c.mu.Unlock()
}

// Warm builds the cache now (call it once the first index pass is over) so the
// first search does not pay for it.
func (e *Engine) Warm(ctx context.Context) error {
	_, err := e.snapshot(ctx)
	return err
}

// snapshot returns an up to date snapshot, or nil when the cache is disabled or the vault is too big.
func (e *Engine) snapshot(ctx context.Context) (*snapshot, error) {
	c := e.c
	if c.budget.Load() <= 0 {
		return nil, nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	tx, err := e.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	var fp fingerprint
	if err := tx.QueryRowContext(ctx, `
		SELECT count(*), COALESCE(max(indexed_at), ''),
		       COALESCE(sum(CASE WHEN kind IN ('md', 'canvas', 'excalidraw') THEN size END), 0)
		FROM files`).Scan(&fp.count, &fp.maxStamp, &fp.textBytes); err != nil {
		return nil, err
	}
	if c.snap != nil && c.snap.fp == fp {
		return usable(c.snap), nil
	}
	if fp.textBytes > c.budget.Load() {
		c.snap = &snapshot{fp: fp, tooBig: true}
		return nil, nil
	}
	next, err := refresh(ctx, tx, c.snap, fp)
	if err != nil {
		return nil, err
	}
	c.snap = next
	return usable(next), nil
}

func usable(s *snapshot) *snapshot {
	if s == nil || s.tooBig {
		return nil
	}
	return s
}

// reloadAllThreshold: above this many changed files one streaming read of the
// whole table beats a lookup per file.
const reloadAllThreshold = 300

func refresh(ctx context.Context, tx *sql.Tx, old *snapshot, fp fingerprint) (*snapshot, error) {
	rows, err := tx.QueryContext(ctx, `SELECT id, path, title, kind, mtime_ns, indexed_at FROM files ORDER BY path`)
	if err != nil {
		return nil, err
	}
	oldBy := map[string]*cachedFile{}
	if old != nil && !old.tooBig {
		for i := range old.files {
			oldBy[old.files[i].meta.path] = &old.files[i]
		}
	}
	next := &snapshot{fp: fp, files: make([]cachedFile, 0, fp.count)}
	var reload []int // indexes into next.files that need body and tags
	for rows.Next() {
		var f cachedFile
		if err := rows.Scan(&f.id, &f.meta.path, &f.meta.title, &f.meta.kind, &f.meta.mtime, &f.indexedAt); err != nil {
			_ = rows.Close()
			return nil, err
		}
		if o, ok := oldBy[f.meta.path]; ok && o.id == f.id && o.indexedAt == f.indexedAt {
			f.body, f.tags = o.body, o.tags
		} else {
			reload = append(reload, len(next.files))
		}
		next.files = append(next.files, f)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if len(reload) > 0 {
		if len(reload) > reloadAllThreshold {
			err = reloadStreaming(ctx, tx, next, reload)
		} else {
			err = reloadEach(ctx, tx, next, reload)
		}
		if err != nil {
			return nil, err
		}
	}
	for i := range next.files {
		next.bytes += int64(len(next.files[i].body))
	}
	if next.bytes > runtimeBudgetCeiling {
		return &snapshot{fp: fp, tooBig: true}, nil
	}
	return next, nil
}

// runtimeBudgetCeiling is a hard stop in case the size estimate of the fingerprint was far off.
const runtimeBudgetCeiling = 2 << 30

func reloadStreaming(ctx context.Context, tx *sql.Tx, s *snapshot, reload []int) error {
	need := make(map[int64]int, len(reload))
	for _, i := range reload {
		need[s.files[i].id] = i
	}
	rows, err := tx.QueryContext(ctx, `SELECT f.id, COALESCE(c.body, '') FROM files f LEFT JOIN fts_content c ON c.rowid = f.id`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id int64
		var body string
		if err := rows.Scan(&id, &body); err != nil {
			_ = rows.Close()
			return err
		}
		if i, ok := need[id]; ok {
			s.files[i].body = body
		}
	}
	if err := rows.Close(); err != nil {
		return err
	}
	byPath := make(map[string]int, len(reload))
	for _, i := range reload {
		byPath[s.files[i].meta.path] = i
		s.files[i].tags = nil
	}
	trows, err := tx.QueryContext(ctx, `SELECT path, name FROM tags`)
	if err != nil {
		return err
	}
	defer func() { _ = trows.Close() }()
	for trows.Next() {
		var p, n string
		if err := trows.Scan(&p, &n); err != nil {
			return err
		}
		if i, ok := byPath[p]; ok {
			s.files[i].tags = append(s.files[i].tags, strings.ToLower(n))
		}
	}
	return trows.Err()
}

func reloadEach(ctx context.Context, tx *sql.Tx, s *snapshot, reload []int) error {
	bodyStmt, err := tx.PrepareContext(ctx, `SELECT body FROM fts_content WHERE rowid = ?`)
	if err != nil {
		return err
	}
	defer func() { _ = bodyStmt.Close() }()
	tagStmt, err := tx.PrepareContext(ctx, `SELECT name FROM tags WHERE path = ?`)
	if err != nil {
		return err
	}
	defer func() { _ = tagStmt.Close() }()
	for _, i := range reload {
		f := &s.files[i]
		f.body, f.tags = "", nil
		if err := bodyStmt.QueryRowContext(ctx, f.id).Scan(&f.body); err != nil && err != sql.ErrNoRows {
			return err
		}
		rows, err := tagStmt.QueryContext(ctx, f.meta.path)
		if err != nil {
			return err
		}
		for rows.Next() {
			var n string
			if err := rows.Scan(&n); err != nil {
				_ = rows.Close()
				return err
			}
			f.tags = append(f.tags, strings.ToLower(n))
		}
		if err := rows.Close(); err != nil {
			return err
		}
	}
	return nil
}

// evalSnapshot runs the query over the cached files on all cores. Chunks keep
// path order, so the hits come out exactly as the streaming path produces them.
func evalSnapshot(ctx context.Context, s *snapshot, node Node) ([]found, error) {
	const chunk = 256
	nChunks := (len(s.files) + chunk - 1) / chunk
	out := make([][]found, nChunks)
	next := atomic.Int64{}
	var firstErr atomic.Value
	var wg sync.WaitGroup
	for w := 0; w < min(runtime.NumCPU(), 8); w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				ci := int(next.Add(1) - 1)
				if ci >= nChunks || firstErr.Load() != nil {
					return
				}
				if err := ctx.Err(); err != nil {
					firstErr.CompareAndSwap(nil, err)
					return
				}
				lo, hi := ci*chunk, min((ci+1)*chunk, len(s.files))
				var hits []found
				for i := lo; i < hi; i++ {
					cf := &s.files[i]
					f := &fileCtx{meta: cf.meta, body: cf.body, bodyLoaded: true, tags: cf.tags, tagsLoaded: true}
					ok, err := eval(ctx, node, f)
					if err != nil {
						firstErr.CompareAndSwap(nil, err)
						return
					}
					if !ok {
						continue
					}
					hits = append(hits, f.result())
				}
				out[ci] = hits
			}
		}()
	}
	wg.Wait()
	if v := firstErr.Load(); v != nil {
		return nil, v.(error)
	}
	var all []found
	for _, h := range out {
		all = append(all, h...)
	}
	return all, nil
}
