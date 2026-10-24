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
	"strings"
	"time"

	"github.com/rs/zerolog"

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

// Full reconciles the whole vault with the index.
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
	changed := 0
	for i, e := range entries {
		seen[e.Path] = true
		if row, ok := known[e.Path]; ok && row.mtimeNs == e.Mtime.UnixNano() && row.size == e.Size {
			continue
		}
		if err := ix.indexEntry(ctx, e, known[e.Path]); err != nil {
			ix.logger.Warn().Err(err).Str("path", e.Path).Msg("index failed")
		}
		changed++
		if changed%50 == 0 {
			ix.progress(Progress{Done: i + 1, Total: len(entries), Path: e.Path})
		}
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
	if err := links.ResolveAll(ctx, ix.db); err != nil {
		return err
	}
	ix.progress(Progress{Done: len(entries), Total: len(entries), Finished: true})
	ix.logger.Info().Int("files", len(entries)).Int("changed", changed).Int("removed", removed).Dur("took", time.Since(start)).Msg("index reconciled")
	return nil
}

// Update refreshes the given vault-relative paths after a watcher batch.
// A path that no longer exists is removed; a folder is walked.
func (ix *Indexer) Update(ctx context.Context, paths []string) error {
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
			continue
		case err != nil:
			return err
		}
		if st.IsDir() {
			if err := ix.walkDir(ctx, normalized); err != nil {
				return err
			}
			continue
		}
		e := vault.Entry{Path: normalized, Name: filepath.Base(abs), Kind: syncproto.KindOf(normalized), Size: st.Size(), Mtime: st.ModTime()}
		if err := ix.indexEntry(ctx, e, fileRow{}); err != nil {
			ix.logger.Warn().Err(err).Str("path", normalized).Msg("index failed")
		}
	}
	// Link targets depend on which files exist, so any change may re-resolve links.
	return links.ResolveAll(ctx, ix.db)
}

func (ix *Indexer) walkDir(ctx context.Context, dir string) error {
	return ix.fs.Walk(func(e vault.Entry) error {
		if e.IsDir || !pathrules.HasPrefix(e.Path, dir) {
			return nil
		}
		return ix.indexEntry(ctx, e, fileRow{})
	})
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

func (ix *Indexer) indexEntry(ctx context.Context, e vault.Entry, prev fileRow) error {
	title := strings.TrimSuffix(e.Name, pathrules.Ext(e.Path))
	if e.Kind != syncproto.KindMarkdown {
		hash, _, err := ix.fs.HashFile(e.Path)
		if err != nil {
			return err
		}
		return ix.write(ctx, e, hash, title, nil, "")
	}
	content, err := ix.fs.ReadFile(e.Path)
	if err != nil {
		return err
	}
	if prev.hash == content.Hash {
		// Touched but identical: just refresh the stat columns.
		_, err := ix.db.ExecContext(ctx, `UPDATE files SET mtime_ns=?, size=?, indexed_at=? WHERE path=?`,
			e.Mtime.UnixNano(), e.Size, time.Now().UTC().Format(time.RFC3339Nano), e.Path)
		return err
	}
	doc := parser.Parse(title, content.Data)
	return ix.write(ctx, e, content.Hash, title, &doc, string(content.Data))
}

func (ix *Indexer) write(ctx context.Context, e vault.Entry, hash, title string, doc *parser.Document, body string) error {
	tx, err := ix.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	for _, table := range []string{"headings", "links", "tags", "aliases", "properties", "tasks", "block_ids"} {
		if _, err := tx.ExecContext(ctx, fmt.Sprintf("DELETE FROM %s WHERE path = ?", table), e.Path); err != nil {
			return err
		}
	}
	wordCount := 0
	if doc != nil {
		wordCount = doc.WordCount
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO files (path, kind, mtime_ns, size, hash, title, word_count, indexed_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(path) DO UPDATE SET kind=excluded.kind, mtime_ns=excluded.mtime_ns, size=excluded.size,
		  hash=excluded.hash, title=excluded.title, word_count=excluded.word_count, indexed_at=excluded.indexed_at`,
		e.Path, string(e.Kind), e.Mtime.UnixNano(), e.Size, hash, title, wordCount, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		return err
	}
	if doc != nil {
		for _, h := range doc.Headings {
			if _, err := tx.ExecContext(ctx, `INSERT INTO headings (path, level, text, line) VALUES (?, ?, ?, ?)`, e.Path, h.Level, h.Text, h.Line); err != nil {
				return err
			}
		}
		for _, l := range doc.Links {
			if _, err := tx.ExecContext(ctx, `INSERT INTO links (path, line, kind, target_raw, target_resolved, heading, block, alias, embed) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
				e.Path, l.Line, string(l.Kind), l.Target, l.Heading, l.Block, l.Alias, l.Embed); err != nil {
				return err
			}
		}
		for _, t := range doc.Tags {
			if _, err := tx.ExecContext(ctx, `INSERT INTO tags (path, line, name) VALUES (?, ?, ?)`, e.Path, t.Line, t.Name); err != nil {
				return err
			}
		}
		for _, a := range doc.Aliases {
			if _, err := tx.ExecContext(ctx, `INSERT INTO aliases (path, name) VALUES (?, ?)`, e.Path, a); err != nil {
				return err
			}
		}
		for k, v := range doc.Properties {
			raw, err := json.Marshal(v)
			if err != nil {
				continue
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO properties (path, key, kind, value) VALUES (?, ?, ?, ?)`, e.Path, k, string(properties.Infer(v)), string(raw)); err != nil {
				return err
			}
		}
		for _, t := range doc.Tasks {
			if _, err := tx.ExecContext(ctx, `INSERT INTO tasks (path, line, state, text) VALUES (?, ?, ?, ?)`, e.Path, t.Line, t.State, t.Text); err != nil {
				return err
			}
		}
		for _, b := range doc.BlockIDs {
			if _, err := tx.ExecContext(ctx, `INSERT INTO block_ids (path, line, id) VALUES (?, ?, ?)`, e.Path, b.Line, b.ID); err != nil {
				return err
			}
		}
	}
	var id int64
	if err := tx.QueryRowContext(ctx, `SELECT id FROM files WHERE path = ?`, e.Path).Scan(&id); err != nil {
		return err
	}
	// The FTS row shares the id of its files row (see the schema comment).
	if _, err := tx.ExecContext(ctx, `DELETE FROM fts_content WHERE rowid = ?`, id); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO fts_content (rowid, path, title, body) VALUES (?, ?, ?, ?)`, id, e.Path, title, body); err != nil {
		return err
	}
	return tx.Commit()
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
