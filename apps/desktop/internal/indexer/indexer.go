// Package indexer keeps index.db in sync with the vault on disk (§2.4):
// a full pass compares (mtime, size, hash) with the stored rows and re-parses
// only what changed; watcher batches update individual paths. The index is
// derived data: Rebuild drops it and starts over.
package indexer

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog"

	"clarae/apps/desktop/internal/canvas"
	"clarae/apps/desktop/internal/drawing"
	"clarae/apps/desktop/internal/links"
	"clarae/apps/desktop/internal/parser"
	"clarae/apps/desktop/internal/properties"
	"clarae/apps/desktop/internal/vault"
	"clarae/shared/pathrules"
	"clarae/shared/syncproto"
)

// Progress is reported while indexing.
type Progress struct {
	Done     int    `json:"done"`
	Total    int    `json:"total"`
	Path     string `json:"path"`
	Finished bool   `json:"finished"`
}

// Indexer maintains one vault's index.
type Indexer struct {
	fs       *vault.FS
	db       *sql.DB
	logger   zerolog.Logger
	progress func(Progress)

	// Writers are serialized (see Full): wmu is held by every write to the
	// index (an Update from start to end, each batch, removal and the final
	// link resolution of a Full, the key index DDL); fullMu keeps two full
	// passes (Full, Rebuild) from running at once. Lock order: fullMu, wmu.
	fullMu sync.Mutex
	wmu    sync.Mutex
	// updated lists the paths an Update wrote while a Full is running (nil
	// otherwise); the Full then leaves them alone. Guarded by wmu.
	updated map[string]bool

	// linksOK is true while every link row is resolved against the current
	// file set: a Full that finds nothing to write or remove can then skip
	// the whole-vault resolution. Only a successful ResolveAll sets it; a
	// Full that writes or removes, a failed Update and Rebuild clear it, so a
	// new Indexer (a vault opened, maybe after a crash half way through a
	// Full) always resolves once. Guarded by wmu.
	linksOK bool

	// res caches the link resolver of the current file set (see Update).
	rmu sync.Mutex
	res *links.Resolver
}

// Reconciled lists what a full pass found changed on disk: files it indexed
// for the first time, files whose content changed, files that are gone.
// Paths an Update handled meanwhile are not listed (their change was
// reported with the watcher batch), nor files whose content is unchanged.
type Reconciled struct {
	Added, Modified, Removed []string
}

// Empty reports whether the pass found no change.
func (r Reconciled) Empty() bool { return len(r.Added)+len(r.Modified)+len(r.Removed) == 0 }

// maxParseBytes caps the notes, canvases and drawings whose content is
// parsed and made searchable: a larger file (a pasted dump of hundreds of
// MB) is indexed by name and path only. A variable for the tests.
var maxParseBytes int64 = 8 << 20

// New binds an indexer to a vault file system and its index database.
func New(fsys *vault.FS, db *sql.DB, logger zerolog.Logger, progress func(Progress)) *Indexer {
	if progress == nil {
		progress = func(Progress) {}
	}
	return &Indexer{fs: fsys, db: db, logger: logger, progress: progress}
}

type fileRow struct {
	mtimeNs int64
	size    int64
	hash    string
}

// DB returns the index database (read access for the links and search packages).
func (ix *Indexer) DB() *sql.DB { return ix.db }

// Batch sizing of the write side: a transaction groups notes until either bound
// is reached. One transaction per note made the WAL commit dominate (about
// half of the time of a 5,000 note index in the CPU profile).
const (
	batchMaxJobs  = 250
	batchMaxBytes = 16 << 20
)

// job is a file read and parsed, ready to be written (no database access needed to build it).
type job struct {
	e     vault.Entry
	hash  string
	title string
	doc   *parser.Document
	body  string
	touch bool // identical content: only the stat columns are refreshed
	skip  bool // preparation failed (already logged): nothing to write
}

func (j job) weight() int { return len(j.body) + 512 }

// Full reconciles the whole vault with the index. Files that changed are read
// and parsed by a pool of workers while a single writer stores them in batched
// transactions.
//
// Concurrency: Full and Update are both writers and are serialized, but a
// Full does not hold the write lock for its whole duration (a first index of
// 50k notes takes about a minute, and an Update from a binding must not wait
// behind it). It takes the lock per batch, for the removals, and for the
// final link resolution; Updates run in between. A path an Update wrote
// while the Full runs is skipped by the Full's later batches and removals:
// the Full may have read that file before the Update did, and writing it
// would bring back older content (the watcher reports any later change with
// another Update). The final ResolveAll re-resolves every link against the
// file set at that moment, so links written by interleaved Updates end up
// consistent too; it holds the lock for its whole run (a few seconds on the
// largest vaults), because resolving later chunks with a resolver that misses
// an interleaved Update's files would undo that Update's resolution. A pass
// that wrote and removed nothing skips it when the links are known to be
// resolved already (see linksOK).
func (ix *Indexer) Full(ctx context.Context) error {
	_, err := ix.Reconcile(ctx)
	return err
}

// Reconcile is Full, reporting which files it found changed (the changes no
// watcher batch reported: events lost or never raised).
func (ix *Indexer) Reconcile(ctx context.Context) (Reconciled, error) {
	ix.fullMu.Lock()
	defer ix.fullMu.Unlock()
	return ix.full(ctx)
}

// full is Reconcile with fullMu held.
func (ix *Indexer) full(ctx context.Context) (Reconciled, error) {
	var res Reconciled
	start := time.Now()
	ix.wmu.Lock()
	ix.updated = map[string]bool{}
	ix.wmu.Unlock()
	defer func() {
		ix.wmu.Lock()
		ix.updated = nil
		ix.wmu.Unlock()
	}()
	known, err := ix.loadRows(ctx)
	if err != nil {
		return res, err
	}
	var entries []vault.Entry
	if err := ix.fs.Walk(func(e vault.Entry) error {
		if !e.IsDir {
			entries = append(entries, e)
		}
		return nil
	}); err != nil {
		return res, err
	}
	seen := make(map[string]bool, len(entries))
	var todo []vault.Entry
	for _, e := range entries {
		seen[e.Path] = true
		if row, ok := known[e.Path]; ok && row.mtimeNs == e.Mtime.UnixNano() && row.size == e.Size {
			continue
		}
		todo = append(todo, e)
	}
	bulk := len(todo) >= bulkMinFiles && 2*len(todo) >= len(entries)
	apply := func(ctx context.Context, jobs []job) (delta, error) {
		st, written, err := ix.applyFullBatch(ctx, jobs)
		for _, p := range written {
			if _, ok := known[p]; ok {
				res.Modified = append(res.Modified, p)
			} else {
				res.Added = append(res.Added, p)
			}
		}
		return st, err
	}
	if err := ix.withKeyIndex(ctx, bulk, func() error {
		_, err := ix.indexBatches(ctx, todo, known, len(entries)-len(todo), len(entries), apply)
		return err
	}); err != nil {
		return res, err
	}
	ix.wmu.Lock()
	defer ix.wmu.Unlock()
	var gone []string
	for p := range known {
		if !seen[p] && !ix.updated[p] {
			gone = append(gone, p)
		}
	}
	if len(gone) > 0 {
		ix.linksOK = false
	}
	if _, err := ix.removeMany(ctx, gone); err != nil {
		return res, err
	}
	sort.Strings(gone)
	res.Removed = gone
	// Nothing written or removed (by this pass, a failed Update or an earlier
	// pass that did not finish): every link is already resolved against this
	// file set, and resolving the whole vault again would only hold the
	// write lock for nothing.
	resolved := !ix.linksOK
	if resolved {
		ix.invalidateResolver()
		if testHookResolveAll != nil {
			testHookResolveAll()
		}
		if err := links.ResolveAll(ctx, ix.db); err != nil {
			return res, err
		}
		ix.linksOK = true
	}
	ix.progress(Progress{Done: len(entries), Total: len(entries), Finished: true})
	ix.logger.Info().Int("files", len(entries)).Int("changed", len(todo)).Int("removed", len(gone)).Bool("resolved", resolved).
		Dur("took", time.Since(start)).Msg("index reconciled")
	return res, nil
}

// testHookResolveAll runs before a Full resolves every link (tests).
var testHookResolveAll func()

// applyFullBatch writes one batch of a Full under the write lock, without
// the paths an Update has written since the Full started. It returns the
// paths whose content it wrote (not the ones only touched).
func (ix *Indexer) applyFullBatch(ctx context.Context, jobs []job) (delta, []string, error) {
	if testHookFullBatch != nil {
		testHookFullBatch()
	}
	ix.wmu.Lock()
	defer ix.wmu.Unlock()
	keep := jobs[:0:0]
	var written []string
	for _, j := range jobs {
		if !ix.updated[j.e.Path] {
			keep = append(keep, j)
			if !j.touch {
				written = append(written, j.e.Path)
			}
		}
	}
	if len(keep) == 0 {
		return delta{}, nil, nil
	}
	if len(written) > 0 {
		ix.linksOK = false // the links written are not resolved yet
	}
	st, err := ix.applyBatch(ctx, keep)
	if st.any {
		// Updates running between batches must not resolve against the
		// file set as it was before this batch.
		ix.invalidateResolver()
	}
	return st, written, err
}

// testHookFullBatch runs before a Full takes the lock for a batch (tests).
var testHookFullBatch func()

// bulkMinFiles is the smallest pass for which Full drops the links_key_ix
// index while writing (see withKeyIndex); a variable for the tests.
var bulkMinFiles = 2000

// createKeyIndex is the index of migration 0003_link_keys.
const createKeyIndex = `CREATE INDEX IF NOT EXISTS links_key_ix ON links(target_key)`

// withKeyIndex runs a write pass. With bulk set (most of the vault is
// written, e.g. a first index) the index on links.target_key is dropped for
// the pass and built again afterwards: one sort is much cheaper than
// keeping a b-tree of random keys up to date for every inserted link (that
// made a cold index of 10k notes about 7% slower). The index is (re)created
// after every pass, so one that dies half way only leaves lookups slower until
// the next Full: they stay correct without it. Both statements run under the
// write lock; Updates interleaved with the pass stay correct without the
// index too, only their link lookups are slower meanwhile.
func (ix *Indexer) withKeyIndex(ctx context.Context, bulk bool, write func() error) error {
	if bulk {
		ix.wmu.Lock()
		_, err := ix.db.ExecContext(ctx, `DROP INDEX IF EXISTS links_key_ix`)
		ix.wmu.Unlock()
		if err != nil {
			return err
		}
	}
	werr := write()
	ix.wmu.Lock()
	_, err := ix.db.ExecContext(context.WithoutCancel(ctx), createKeyIndex)
	ix.wmu.Unlock()
	return errors.Join(werr, err)
}

// indexBatches prepares the entries concurrently and writes them in batches
// with apply. It reports how the set of files or aliases changed.
func (ix *Indexer) indexBatches(ctx context.Context, todo []vault.Entry, known map[string]fileRow, doneBase, total int,
	apply func(context.Context, []job) (delta, error),
) (delta, error) {
	var structural delta
	if len(todo) == 0 {
		return structural, nil
	}
	workers := min(runtime.NumCPU(), 8)
	in := make(chan vault.Entry)
	out := make(chan job, workers*2)
	// On an early return (a failed batch, a cancelled context) the feeder
	// stops and the workers' last jobs are drained: none may stay blocked
	// on out once this returns.
	feedCtx, stopFeed := context.WithCancel(ctx)
	defer func() {
		stopFeed()
		for range out {
		}
	}()
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for e := range in {
				j, err := ix.prepare(e, known[e.Path])
				if err != nil {
					ix.logger.Warn().Err(err).Str("path", e.Path).Msg("index failed")
					out <- job{e: e, skip: true}
					continue
				}
				out <- j
			}
		}()
	}
	go func() {
		defer close(in)
		for _, e := range todo {
			select {
			case in <- e:
			case <-feedCtx.Done():
				return
			}
		}
	}()
	go func() { wg.Wait(); close(out) }()

	var batch []job
	weight, processed := 0, 0
	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		st, err := apply(ctx, batch)
		structural.merge(st)
		processed += len(batch)
		batch, weight = batch[:0], 0
		last := todo[min(processed, len(todo))-1]
		ix.progress(Progress{Done: doneBase + processed, Total: total, Path: last.Path})
		return err
	}
	for j := range out {
		if j.skip {
			processed++
			continue
		}
		batch = append(batch, j)
		weight += j.weight()
		if len(batch) >= batchMaxJobs || weight >= batchMaxBytes {
			if err := flush(); err != nil {
				return structural, err
			}
		}
	}
	if err := flush(); err != nil {
		return structural, err
	}
	return structural, ctx.Err()
}

// Update refreshes the given vault-relative paths after a watcher batch.
// A path that no longer exists is removed; a folder is walked. It holds the
// write lock from start to end (see Full).
func (ix *Indexer) Update(ctx context.Context, paths []string) (err error) {
	ix.wmu.Lock()
	defer ix.wmu.Unlock()
	defer func() {
		if err != nil {
			// What was written may be left unresolved: the next Full resolves everything.
			ix.linksOK = false
		}
	}()
	var entries []vault.Entry
	var structural delta
	for _, p := range paths {
		abs, normalized, err := ix.fs.Resolve(p)
		if err != nil {
			continue
		}
		st, err := os.Stat(abs)
		switch {
		case errors.Is(err, fs.ErrNotExist):
			d, err := ix.removePrefix(ctx, normalized)
			ix.markUpdated(normalized)
			ix.markUpdated(d.removed...)
			if err != nil {
				return err
			}
			structural.merge(d)
			continue
		case err != nil:
			return err
		}
		if st.IsDir() {
			// Only the folder is walked, not the whole vault.
			if err := ix.fs.WalkDir(normalized, func(e vault.Entry) error {
				if !e.IsDir {
					entries = append(entries, e)
				}
				return nil
			}); err != nil {
				return err
			}
			continue
		}
		entries = append(entries, vault.Entry{Path: normalized, Name: filepath.Base(abs), Kind: syncproto.KindOf(normalized), Size: st.Size(), Mtime: st.ModTime()})
	}
	for _, e := range entries {
		ix.markUpdated(e.Path)
	}
	// The stored hashes let identical content through as a touch (stat
	// columns only): the watcher reports every write a binding has already
	// indexed, and parsing and rewriting the FTS row again would be wasted.
	known, err := ix.knownRows(ctx, entries)
	if err != nil {
		return err
	}
	st, err := ix.indexBatches(ctx, entries, known, 0, len(entries), ix.applyBatch)
	if err != nil {
		return err
	}
	structural.merge(st)
	// Link targets depend on which files and aliases exist: when that set changed, the links
	// that could resolve differently (see links.ResolveAffected) are resolved again with a
	// fresh resolver. The links of the notes written are resolved in any case.
	if structural.any {
		ix.invalidateResolver()
	}
	r, err := ix.getResolver(ctx)
	if err != nil {
		return err
	}
	ch := links.Change{Tokens: structural.tokens, Removed: structural.removed, Paths: make([]string, len(entries))}
	for i, e := range entries {
		ch.Paths[i] = e.Path
	}
	return links.ResolveAffected(ctx, ix.db, r, ch)
}

// markUpdated records paths an Update wrote while a Full runs. wmu held.
func (ix *Indexer) markUpdated(paths ...string) {
	if ix.updated == nil {
		return
	}
	for _, p := range paths {
		ix.updated[p] = true
	}
}

// delta is how a write changed the set of files and aliases link resolution works on.
type delta struct {
	tokens  []string // links.FileTokens / links.AliasTokens of what appeared, disappeared or changed
	removed []string // paths removed
	any     bool     // the set changed
}

func (d *delta) merge(o delta) {
	d.tokens = append(d.tokens, o.tokens...)
	d.removed = append(d.removed, o.removed...)
	d.any = d.any || o.any
}

// invalidateResolver drops the cached resolver: the next Update loads one for
// the current file set.
func (ix *Indexer) invalidateResolver() {
	ix.rmu.Lock()
	ix.res = nil
	ix.rmu.Unlock()
}

// getResolver returns the cached resolver of the current file set, loading it on first use.
func (ix *Indexer) getResolver(ctx context.Context) (*links.Resolver, error) {
	ix.rmu.Lock()
	defer ix.rmu.Unlock()
	if ix.res == nil {
		r, err := links.Load(ctx, ix.db)
		if err != nil {
			return nil, err
		}
		ix.res = r
	}
	return ix.res, nil
}

// Rebuild clears every table and runs a full pass.
func (ix *Indexer) Rebuild(ctx context.Context) error {
	ix.fullMu.Lock()
	defer ix.fullMu.Unlock()
	ix.wmu.Lock()
	for _, table := range []string{"fts_content", "aliases", "tags", "links", "headings", "properties", "tasks", "block_ids", "files"} {
		if _, err := ix.db.ExecContext(ctx, "DELETE FROM "+table); err != nil { //nolint:gosec // table names are constants
			ix.wmu.Unlock()
			return err
		}
	}
	ix.invalidateResolver()
	ix.linksOK = false
	ix.wmu.Unlock()
	_, err := ix.full(ctx)
	return err
}

func (ix *Indexer) loadRows(ctx context.Context) (map[string]fileRow, error) {
	rows, err := ix.db.QueryContext(ctx, `SELECT path, mtime_ns, size, hash FROM files`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := map[string]fileRow{}
	for rows.Next() {
		var p string
		var r fileRow
		if err := rows.Scan(&p, &r.mtimeNs, &r.size, &r.hash); err != nil {
			return nil, err
		}
		out[p] = r
	}
	return out, rows.Err()
}

// knownRowsAllAbove: past this many entries one scan of the files table is
// cheaper than a lookup per path.
const knownRowsAllAbove = 500

// knownRows returns the stored stat and hash of the entries that are indexed.
func (ix *Indexer) knownRows(ctx context.Context, entries []vault.Entry) (map[string]fileRow, error) {
	if len(entries) > knownRowsAllAbove {
		return ix.loadRows(ctx)
	}
	out := make(map[string]fileRow, len(entries))
	if len(entries) == 0 {
		return out, nil
	}
	stmt, err := ix.db.PrepareContext(ctx, `SELECT mtime_ns, size, hash FROM files WHERE path = ?`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = stmt.Close() }()
	for _, e := range entries {
		var r fileRow
		switch err := stmt.QueryRowContext(ctx, e.Path).Scan(&r.mtimeNs, &r.size, &r.hash); {
		case errors.Is(err, sql.ErrNoRows):
		case err != nil:
			return nil, err
		default:
			out[e.Path] = r
		}
	}
	return out, nil
}

// prepare reads and parses one file without touching the database.
func (ix *Indexer) prepare(e vault.Entry, prev fileRow) (job, error) {
	title := strings.TrimSuffix(e.Name, pathrules.Ext(e.Path))
	parsed := e.Kind == syncproto.KindMarkdown || e.Kind == syncproto.KindExcalidraw || e.Kind == syncproto.KindCanvas
	if !parsed || e.Size > maxParseBytes {
		// Streamed, never loaded: an attachment, or a text file too large to parse.
		hash, _, err := ix.fs.HashFile(e.Path)
		if err != nil {
			return job{}, err
		}
		if prev.hash == hash {
			return job{e: e, touch: true}, nil // touched but identical
		}
		if parsed {
			ix.logOversize(e)
		}
		return job{e: e, hash: hash, title: title}, nil
	}
	if e.Kind != syncproto.KindMarkdown {
		return ix.prepareStructured(e, prev, title)
	}
	content, err := ix.fs.ReadFile(e.Path)
	if err != nil {
		return job{}, err
	}
	if prev.hash == content.Hash {
		return job{e: e, touch: true}, nil // touched but identical
	}
	if content.Size > maxParseBytes { // grown since the stat
		ix.logOversize(e)
		return job{e: e, hash: content.Hash, title: title}, nil
	}
	doc := parser.Parse(title, content.Data)
	return job{e: e, hash: content.Hash, title: title, doc: &doc, body: string(content.Data)}, nil
}

// logOversize reports a file indexed by name only (see maxParseBytes).
func (ix *Indexer) logOversize(e vault.Entry) {
	ix.logger.Warn().Str("path", e.Path).Int64("size", e.Size).Int64("limit", maxParseBytes).
		Msg("file too large to index its content: indexed by name only")
}

// prepareStructured handles a drawing or a canvas: the text of its elements is searchable
// and the links they hold feed the graph and the backlinks. A file that does not
// parse stays listed (and searchable by name) with a warning, never blocks the pass.
func (ix *Indexer) prepareStructured(e vault.Entry, prev fileRow, title string) (job, error) {
	content, err := ix.fs.ReadFile(e.Path)
	if err != nil {
		return job{}, err
	}
	if prev.hash == content.Hash {
		return job{e: e, touch: true}, nil
	}
	if content.Size > maxParseBytes { // grown since the stat
		ix.logOversize(e)
		return job{e: e, hash: content.Hash, title: title}, nil
	}
	var text string
	var found []parser.Link
	if e.Kind == syncproto.KindExcalidraw {
		d, perr := drawing.Parse(content.Data)
		if perr != nil {
			ix.logger.Warn().Err(perr).Str("path", e.Path).Msg("drawing not indexed")
		}
		for _, w := range d.Warnings {
			ix.logger.Warn().Str("path", e.Path).Msg("drawing: " + w)
		}
		text, found = d.Text, d.Links
	} else {
		d, perr := canvas.Extract(content.Data)
		if perr != nil {
			ix.logger.Warn().Err(perr).Str("path", e.Path).Msg("canvas not indexed")
		}
		text, found = d.Text, d.Links
	}
	doc := parser.Document{Title: title, Links: found, WordCount: len(strings.Fields(text))}
	return job{e: e, hash: content.Hash, title: title, doc: &doc, body: text}, nil
}

// applyBatch writes the jobs in one transaction. If the batch fails as a whole
// (one bad row must not lose the others) the jobs are retried one by one and
// the failing ones are logged and skipped.
func (ix *Indexer) applyBatch(ctx context.Context, jobs []job) (delta, error) {
	structural, err := ix.applyTx(ctx, jobs)
	if err == nil {
		return structural, nil
	}
	if ctx.Err() != nil {
		return delta{}, ctx.Err()
	}
	structural = delta{}
	for _, j := range jobs {
		st, err := ix.applyTx(ctx, []job{j})
		if err != nil {
			ix.logger.Warn().Err(err).Str("path", j.e.Path).Msg("index failed")
			continue
		}
		structural.merge(st)
	}
	return structural, nil
}

func (ix *Indexer) applyTx(ctx context.Context, jobs []job) (delta, error) {
	var structural delta
	tx, err := ix.db.BeginTx(ctx, nil)
	if err != nil {
		return structural, err
	}
	defer func() { _ = tx.Rollback() }()
	w := &txWriter{tx: tx, stmts: map[string]*sql.Stmt{}}
	defer w.close()
	// The FTS rows are written after every other table of the batch: once a
	// transaction has touched the FTS5 table, each later statement that opens a
	// statement journal (all the foreign-key inserts do) makes FTS5 flush its
	// in-memory segment to disk, which was most of the indexing time.
	ids := make([]int64, len(jobs))
	exists := make([]bool, len(jobs))
	for i, j := range jobs {
		st, err := w.apply(ctx, j, &ids[i], &exists[i])
		if err != nil {
			return delta{}, err
		}
		structural.merge(st)
	}
	for i, j := range jobs {
		if j.touch {
			continue
		}
		if err := w.writeFTS(ctx, j, ids[i], exists[i]); err != nil {
			return delta{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return delta{}, err
	}
	return structural, nil
}

// txWriter caches prepared statements for the lifetime of one transaction.
type txWriter struct {
	tx    *sql.Tx
	stmts map[string]*sql.Stmt
}

func (w *txWriter) stmt(ctx context.Context, q string) (*sql.Stmt, error) {
	if s, ok := w.stmts[q]; ok {
		return s, nil
	}
	s, err := w.tx.PrepareContext(ctx, q)
	if err != nil {
		return nil, err
	}
	w.stmts[q] = s
	return s, nil
}

func (w *txWriter) exec(ctx context.Context, q string, args ...any) error {
	s, err := w.stmt(ctx, q)
	if err != nil {
		return err
	}
	_, err = s.ExecContext(ctx, args...)
	return err
}

func (w *txWriter) close() {
	for _, s := range w.stmts {
		_ = s.Close()
	}
}

// deleteDerived are the per-path tables rewritten on every change of a file.
var deleteDerived = []string{
	`DELETE FROM headings WHERE path = ?`, `DELETE FROM links WHERE path = ?`, `DELETE FROM tags WHERE path = ?`,
	`DELETE FROM aliases WHERE path = ?`, `DELETE FROM properties WHERE path = ?`, `DELETE FROM tasks WHERE path = ?`,
	`DELETE FROM block_ids WHERE path = ?`,
}

// apply stores one job. It reports whether the file is new or its aliases
// changed, i.e. whether the resolution of links in other notes may be affected.
func (w *txWriter) apply(ctx context.Context, j job, outID *int64, outExists *bool) (delta, error) {
	e := j.e
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if j.touch {
		return delta{}, w.exec(ctx, `UPDATE files SET mtime_ns=?, size=?, indexed_at=? WHERE path=?`, e.Mtime.UnixNano(), e.Size, now, e.Path)
	}
	var id int64
	exists := true
	sel, err := w.stmt(ctx, `SELECT id FROM files WHERE path = ?`)
	if err != nil {
		return delta{}, err
	}
	if err := sel.QueryRowContext(ctx, e.Path).Scan(&id); errors.Is(err, sql.ErrNoRows) {
		exists = false
	} else if err != nil {
		return delta{}, err
	}
	var oldAliases []string
	if exists {
		rows, err := w.tx.QueryContext(ctx, `SELECT name FROM aliases WHERE path = ?`, e.Path)
		if err != nil {
			return delta{}, err
		}
		for rows.Next() {
			var n string
			if err := rows.Scan(&n); err != nil {
				_ = rows.Close()
				return delta{}, err
			}
			oldAliases = append(oldAliases, n)
		}
		if err := rows.Close(); err != nil {
			return delta{}, err
		}
		for _, q := range deleteDerived {
			if err := w.exec(ctx, q, e.Path); err != nil {
				return delta{}, err
			}
		}
	}
	wordCount := 0
	var newAliases []string
	if j.doc != nil {
		wordCount = j.doc.WordCount
		newAliases = j.doc.Aliases
	}
	up, err := w.stmt(ctx, `
		INSERT INTO files (path, kind, mtime_ns, size, hash, title, word_count, indexed_at, body_bytes)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(path) DO UPDATE SET kind=excluded.kind, mtime_ns=excluded.mtime_ns, size=excluded.size,
		  hash=excluded.hash, title=excluded.title, word_count=excluded.word_count, indexed_at=excluded.indexed_at,
		  body_bytes=excluded.body_bytes
		RETURNING id`)
	if err != nil {
		return delta{}, err
	}
	if err := up.QueryRowContext(ctx, e.Path, string(e.Kind), e.Mtime.UnixNano(), e.Size, j.hash, j.title, wordCount, now, len(j.body)).Scan(&id); err != nil {
		return delta{}, err
	}
	if doc := j.doc; doc != nil {
		for _, h := range doc.Headings {
			if err := w.exec(ctx, `INSERT INTO headings (path, level, text, line) VALUES (?, ?, ?, ?)`, e.Path, h.Level, h.Text, h.Line); err != nil {
				return delta{}, err
			}
		}
		for _, l := range doc.Links {
			if err := w.exec(ctx, `INSERT INTO links (path, line, kind, target_raw, target_resolved, heading, block, alias, embed, target_key) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
				e.Path, l.Line, string(l.Kind), l.Target, l.Heading, l.Block, l.Alias, l.Embed, links.LinkKey(e.Path, string(l.Kind), l.Target)); err != nil {
				return delta{}, err
			}
		}
		for _, t := range doc.Tags {
			if err := w.exec(ctx, `INSERT INTO tags (path, line, name) VALUES (?, ?, ?)`, e.Path, t.Line, t.Name); err != nil {
				return delta{}, err
			}
		}
		for _, a := range doc.Aliases {
			if err := w.exec(ctx, `INSERT INTO aliases (path, name) VALUES (?, ?)`, e.Path, a); err != nil {
				return delta{}, err
			}
		}
		for k, v := range doc.Properties {
			raw, err := json.Marshal(v)
			if err != nil {
				continue
			}
			if err := w.exec(ctx, `INSERT INTO properties (path, key, kind, value) VALUES (?, ?, ?, ?)`, e.Path, k, string(properties.Infer(v)), string(raw)); err != nil {
				return delta{}, err
			}
		}
		for _, t := range doc.Tasks {
			if err := w.exec(ctx, `INSERT INTO tasks (path, line, state, text) VALUES (?, ?, ?, ?)`, e.Path, t.Line, t.State, t.Text); err != nil {
				return delta{}, err
			}
		}
		for _, b := range doc.BlockIDs {
			if err := w.exec(ctx, `INSERT INTO block_ids (path, line, id) VALUES (?, ?, ?)`, e.Path, b.Line, b.ID); err != nil {
				return delta{}, err
			}
		}
	}
	*outID, *outExists = id, exists
	switch {
	case !exists:
		return delta{tokens: links.FileTokens(e.Path, newAliases), any: true}, nil
	case !sameSet(oldAliases, newAliases):
		return delta{tokens: links.AliasTokens(append(oldAliases, newAliases...)), any: true}, nil
	}
	return delta{}, nil
}

// writeFTS stores the searchable text; its rowid is the id of the files row (see the schema comment).
func (w *txWriter) writeFTS(ctx context.Context, j job, id int64, exists bool) error {
	if exists {
		if err := w.exec(ctx, `DELETE FROM fts_content WHERE rowid = ?`, id); err != nil {
			return err
		}
	}
	return w.exec(ctx, `INSERT INTO fts_content (rowid, path, title, body) VALUES (?, ?, ?, ?)`, id, j.e.Path, j.title, j.body)
}

func sameSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	m := make(map[string]int, len(a))
	for _, x := range a {
		m[x]++
	}
	for _, x := range b {
		m[x]--
	}
	for _, n := range m {
		if n != 0 {
			return false
		}
	}
	return true
}

// removeChunk bounds the files removed in one transaction (removing a large
// folder must not hold one huge write transaction either).
const removeChunk = 500

// removeMany drops files from the index, in transactions of removeChunk
// files, and returns how that changed the file set.
func (ix *Indexer) removeMany(ctx context.Context, paths []string) (delta, error) {
	var d delta
	for len(paths) > 0 {
		n := min(len(paths), removeChunk)
		r, err := ix.removeTx(ctx, paths[:n])
		if err != nil {
			return d, err
		}
		d.merge(r)
		paths = paths[n:]
	}
	return d, nil
}

// removeTx drops files from the index in one transaction.
func (ix *Indexer) removeTx(ctx context.Context, paths []string) (delta, error) {
	tx, err := ix.db.BeginTx(ctx, nil)
	if err != nil {
		return delta{}, err
	}
	defer func() { _ = tx.Rollback() }()
	w := &txWriter{tx: tx, stmts: map[string]*sql.Stmt{}}
	defer w.close()
	var d delta
	for _, path := range paths {
		var aliases []string
		sel, err := w.stmt(ctx, `SELECT name FROM aliases WHERE path = ?`)
		if err != nil {
			return delta{}, err
		}
		rows, err := sel.QueryContext(ctx, path)
		if err != nil {
			return delta{}, err
		}
		for rows.Next() {
			var n string
			if err := rows.Scan(&n); err != nil {
				_ = rows.Close()
				return delta{}, err
			}
			aliases = append(aliases, n)
		}
		if err := rows.Close(); err != nil {
			return delta{}, err
		}
		if err := w.exec(ctx, `DELETE FROM fts_content WHERE rowid = (SELECT id FROM files WHERE path = ?)`, path); err != nil {
			return delta{}, err
		}
		for _, table := range []string{"aliases", "tags", "links", "headings", "properties", "tasks", "block_ids", "files"} {
			if err := w.exec(ctx, "DELETE FROM "+table+" WHERE path = ?", path); err != nil {
				return delta{}, err
			}
		}
		d.merge(delta{tokens: links.FileTokens(path, aliases), removed: []string{path}, any: true})
	}
	if err := tx.Commit(); err != nil {
		return delta{}, err
	}
	return d, nil
}

// removePrefix removes a path and, if it was a folder, everything under it.
func (ix *Indexer) removePrefix(ctx context.Context, path string) (delta, error) {
	rows, err := ix.db.QueryContext(ctx, `SELECT path FROM files WHERE path = ? OR path LIKE ? ESCAPE '\'`, path, escapeLike(path)+"/%")
	if err != nil {
		return delta{}, err
	}
	var paths []string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			_ = rows.Close()
			return delta{}, err
		}
		paths = append(paths, p)
	}
	if err := rows.Close(); err != nil {
		return delta{}, err
	}
	return ix.removeMany(ctx, paths)
}

func escapeLike(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return r.Replace(s)
}

// Hit is a search result.
type Hit struct {
	Path    string `json:"path"`
	Title   string `json:"title"`
	Snippet string `json:"snippet"`
}

// Search runs a plain full-text query (substring semantics via trigram). The
// full query language of §2.4 arrives with M1-WP4.
func (ix *Indexer) Search(ctx context.Context, q string, limit int) ([]Hit, error) {
	q = strings.TrimSpace(q)
	if len([]rune(q)) < 3 {
		return []Hit{}, nil
	}
	if limit <= 0 {
		limit = 50
	}
	// Quote the query so FTS operators in user input are treated literally.
	rows, err := ix.db.QueryContext(ctx, `
		SELECT path, title, snippet(fts_content, 2, '<mark>', '</mark>', '…', 12)
		FROM fts_content WHERE fts_content MATCH ? ORDER BY bm25(fts_content) LIMIT ?`,
		`"`+strings.ReplaceAll(q, `"`, `""`)+`"`, limit)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	hits := []Hit{}
	for rows.Next() {
		var h Hit
		if err := rows.Scan(&h.Path, &h.Title, &h.Snippet); err != nil {
			return nil, err
		}
		hits = append(hits, h)
	}
	return hits, rows.Err()
}
