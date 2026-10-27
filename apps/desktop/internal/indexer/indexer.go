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
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog"

	"nodus/apps/desktop/internal/canvas"
	"nodus/apps/desktop/internal/drawing"
	"nodus/apps/desktop/internal/links"
	"nodus/apps/desktop/internal/parser"
	"nodus/apps/desktop/internal/properties"
	"nodus/apps/desktop/internal/vault"
	"nodus/shared/pathrules"
	"nodus/shared/syncproto"
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

	// res caches the link resolver of the current file set (see Update).
	rmu sync.Mutex
	res *links.Resolver
}

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
func (ix *Indexer) Full(ctx context.Context) error {
	start := time.Now()
	known, err := ix.loadRows(ctx)
	if err != nil {
		return err
	}
	var entries []vault.Entry
	if err := ix.fs.Walk(func(e vault.Entry) error {
		if !e.IsDir {
			entries = append(entries, e)
		}
		return nil
	}); err != nil {
		return err
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
	if _, err := ix.indexBatches(ctx, todo, known, len(entries)-len(todo), len(entries)); err != nil {
		return err
	}
	removed := 0
	for p := range known {
		if !seen[p] {
			if err := ix.remove(ctx, p); err != nil {
				return err
			}
			removed++
		}
	}
	ix.setResolver(nil)
	if err := links.ResolveAll(ctx, ix.db); err != nil {
		return err
	}
	ix.progress(Progress{Done: len(entries), Total: len(entries), Finished: true})
	ix.logger.Info().Int("files", len(entries)).Int("changed", len(todo)).Int("removed", removed).Dur("took", time.Since(start)).Msg("index reconciled")
	return nil
}

// indexBatches prepares the entries concurrently and writes them in batches.
// It reports whether any write changed the set of files or aliases.
func (ix *Indexer) indexBatches(ctx context.Context, todo []vault.Entry, known map[string]fileRow, doneBase, total int) (bool, error) {
	if len(todo) == 0 {
		return false, nil
	}
	workers := min(runtime.NumCPU(), 8)
	in := make(chan vault.Entry)
	out := make(chan job, workers*2)
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
			case <-ctx.Done():
				return
			}
		}
	}()
	go func() { wg.Wait(); close(out) }()

	var batch []job
	weight, processed, structural := 0, 0, false
	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		st, err := ix.applyBatch(ctx, batch)
		structural = structural || st
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
// A path that no longer exists is removed; a folder is walked.
func (ix *Indexer) Update(ctx context.Context, paths []string) error {
	var entries []vault.Entry
	structural := false
	for _, p := range paths {
		abs, normalized, err := ix.fs.Resolve(p)
		if err != nil {
			continue
		}
		st, err := os.Stat(abs)
		switch {
		case errors.Is(err, fs.ErrNotExist):
			if err := ix.removePrefix(ctx, normalized); err != nil {
				return err
			}
			structural = true
			continue
		case err != nil:
			return err
		}
		if st.IsDir() {
			if err := ix.fs.Walk(func(e vault.Entry) error {
				if !e.IsDir && pathrules.HasPrefix(e.Path, normalized) {
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
	st, err := ix.indexBatches(ctx, entries, map[string]fileRow{}, 0, len(entries))
	if err != nil {
		return err
	}
	// Link targets depend on which files and aliases exist: when that set changed every link may
	// resolve differently. A plain edit only re-resolves the links of the notes it touched.
	if structural || st {
		ix.setResolver(nil)
		return links.ResolveAll(ctx, ix.db)
	}
	r, err := ix.getResolver(ctx)
	if err != nil {
		return err
	}
	changed := make([]string, len(entries))
	for i, e := range entries {
		changed[i] = e.Path
	}
	return links.ResolvePaths(ctx, ix.db, r, changed)
}

func (ix *Indexer) setResolver(r *links.Resolver) {
	ix.rmu.Lock()
	ix.res = r
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
	for _, table := range []string{"fts_content", "aliases", "tags", "links", "headings", "properties", "tasks", "block_ids", "files"} {
		if _, err := ix.db.ExecContext(ctx, "DELETE FROM "+table); err != nil { //nolint:gosec // table names are constants
			return err
		}
	}
	return ix.Full(ctx)
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

// prepare reads and parses one file without touching the database.
func (ix *Indexer) prepare(e vault.Entry, prev fileRow) (job, error) {
	title := strings.TrimSuffix(e.Name, pathrules.Ext(e.Path))
	if e.Kind == syncproto.KindExcalidraw || e.Kind == syncproto.KindCanvas {
		return ix.prepareStructured(e, prev, title)
	}
	if e.Kind != syncproto.KindMarkdown {
		hash, _, err := ix.fs.HashFile(e.Path)
		if err != nil {
			return job{}, err
		}
		return job{e: e, hash: hash, title: title}, nil
	}
	content, err := ix.fs.ReadFile(e.Path)
	if err != nil {
		return job{}, err
	}
	if prev.hash == content.Hash {
		return job{e: e, touch: true}, nil // touched but identical
	}
	doc := parser.Parse(title, content.Data)
	return job{e: e, hash: content.Hash, title: title, doc: &doc, body: string(content.Data)}, nil
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
	var text string
	var found []parser.Link
	if e.Kind == syncproto.KindExcalidraw {
		d, perr := drawing.Parse(content.Data)
		if perr != nil {
			ix.logger.Warn().Err(perr).Str("path", e.Path).Msg("drawing not indexed")
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
func (ix *Indexer) applyBatch(ctx context.Context, jobs []job) (bool, error) {
	structural, err := ix.applyTx(ctx, jobs)
	if err == nil {
		return structural, nil
	}
	if ctx.Err() != nil {
		return false, ctx.Err()
	}
	structural = false
	for _, j := range jobs {
		st, err := ix.applyTx(ctx, []job{j})
		if err != nil {
			ix.logger.Warn().Err(err).Str("path", j.e.Path).Msg("index failed")
			continue
		}
		structural = structural || st
	}
	return structural, nil
}

func (ix *Indexer) applyTx(ctx context.Context, jobs []job) (bool, error) {
	tx, err := ix.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback() }()
	w := &txWriter{tx: tx, stmts: map[string]*sql.Stmt{}}
	defer w.close()
	// The FTS rows are written after every other table of the batch: once a
	// transaction has touched the FTS5 table, each later statement that opens a
	// statement journal (all the foreign-key inserts do) makes FTS5 flush its
	// in-memory segment to disk, which was most of the indexing time.
	structural := false
	ids := make([]int64, len(jobs))
	exists := make([]bool, len(jobs))
	for i, j := range jobs {
		st, err := w.apply(ctx, j, &ids[i], &exists[i])
		if err != nil {
			return false, err
		}
		structural = structural || st
	}
	for i, j := range jobs {
		if j.touch {
			continue
		}
		if err := w.writeFTS(ctx, j, ids[i], exists[i]); err != nil {
			return false, err
		}
	}
	return structural, tx.Commit()
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
// changed, i.e. whether link resolution of the whole vault may be affected.
func (w *txWriter) apply(ctx context.Context, j job, outID *int64, outExists *bool) (bool, error) {
	e := j.e
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if j.touch {
		return false, w.exec(ctx, `UPDATE files SET mtime_ns=?, size=?, indexed_at=? WHERE path=?`, e.Mtime.UnixNano(), e.Size, now, e.Path)
	}
	var id int64
	exists := true
	sel, err := w.stmt(ctx, `SELECT id FROM files WHERE path = ?`)
	if err != nil {
		return false, err
	}
	if err := sel.QueryRowContext(ctx, e.Path).Scan(&id); errors.Is(err, sql.ErrNoRows) {
		exists = false
	} else if err != nil {
		return false, err
	}
	var oldAliases []string
	if exists {
		rows, err := w.tx.QueryContext(ctx, `SELECT name FROM aliases WHERE path = ?`, e.Path)
		if err != nil {
			return false, err
		}
		for rows.Next() {
			var n string
			if err := rows.Scan(&n); err != nil {
				_ = rows.Close()
				return false, err
			}
			oldAliases = append(oldAliases, n)
		}
		if err := rows.Close(); err != nil {
			return false, err
		}
		for _, q := range deleteDerived {
			if err := w.exec(ctx, q, e.Path); err != nil {
				return false, err
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
		INSERT INTO files (path, kind, mtime_ns, size, hash, title, word_count, indexed_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(path) DO UPDATE SET kind=excluded.kind, mtime_ns=excluded.mtime_ns, size=excluded.size,
		  hash=excluded.hash, title=excluded.title, word_count=excluded.word_count, indexed_at=excluded.indexed_at
		RETURNING id`)
	if err != nil {
		return false, err
	}
	if err := up.QueryRowContext(ctx, e.Path, string(e.Kind), e.Mtime.UnixNano(), e.Size, j.hash, j.title, wordCount, now).Scan(&id); err != nil {
		return false, err
	}
	if doc := j.doc; doc != nil {
		for _, h := range doc.Headings {
			if err := w.exec(ctx, `INSERT INTO headings (path, level, text, line) VALUES (?, ?, ?, ?)`, e.Path, h.Level, h.Text, h.Line); err != nil {
				return false, err
			}
		}
		for _, l := range doc.Links {
			if err := w.exec(ctx, `INSERT INTO links (path, line, kind, target_raw, target_resolved, heading, block, alias, embed) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
				e.Path, l.Line, string(l.Kind), l.Target, l.Heading, l.Block, l.Alias, l.Embed); err != nil {
				return false, err
			}
		}
		for _, t := range doc.Tags {
			if err := w.exec(ctx, `INSERT INTO tags (path, line, name) VALUES (?, ?, ?)`, e.Path, t.Line, t.Name); err != nil {
				return false, err
			}
		}
		for _, a := range doc.Aliases {
			if err := w.exec(ctx, `INSERT INTO aliases (path, name) VALUES (?, ?)`, e.Path, a); err != nil {
				return false, err
			}
		}
		for k, v := range doc.Properties {
			raw, err := json.Marshal(v)
			if err != nil {
				continue
			}
			if err := w.exec(ctx, `INSERT INTO properties (path, key, kind, value) VALUES (?, ?, ?, ?)`, e.Path, k, string(properties.Infer(v)), string(raw)); err != nil {
				return false, err
			}
		}
		for _, t := range doc.Tasks {
			if err := w.exec(ctx, `INSERT INTO tasks (path, line, state, text) VALUES (?, ?, ?, ?)`, e.Path, t.Line, t.State, t.Text); err != nil {
				return false, err
			}
		}
		for _, b := range doc.BlockIDs {
			if err := w.exec(ctx, `INSERT INTO block_ids (path, line, id) VALUES (?, ?, ?)`, e.Path, b.Line, b.ID); err != nil {
				return false, err
			}
		}
	}
	*outID, *outExists = id, exists
	return !exists || !sameSet(oldAliases, newAliases), nil
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

func (ix *Indexer) remove(ctx context.Context, path string) error {
	tx, err := ix.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `DELETE FROM fts_content WHERE rowid = (SELECT id FROM files WHERE path = ?)`, path); err != nil {
		return err
	}
	for _, table := range []string{"aliases", "tags", "links", "headings", "properties", "tasks", "block_ids", "files"} {
		if _, err := tx.ExecContext(ctx, fmt.Sprintf("DELETE FROM %s WHERE path = ?", table), path); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// removePrefix removes a path and, if it was a folder, everything under it.
func (ix *Indexer) removePrefix(ctx context.Context, path string) error {
	rows, err := ix.db.QueryContext(ctx, `SELECT path FROM files WHERE path = ? OR path LIKE ? ESCAPE '\'`, path, escapeLike(path)+"/%")
	if err != nil {
		return err
	}
	var paths []string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			_ = rows.Close()
			return err
		}
		paths = append(paths, p)
	}
	_ = rows.Close()
	for _, p := range paths {
		if err := ix.remove(ctx, p); err != nil {
			return err
		}
	}
	return nil
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
