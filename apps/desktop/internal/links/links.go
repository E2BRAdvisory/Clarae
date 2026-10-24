// Package links resolves link targets to vault files and answers the
// questions built on them: outgoing links, backlinks and unlinked mentions
// (§2.2.1, §2.5 "links"). Resolution follows Obsidian's "shortest path"
// behavior and works on the index (index.db), never on the file system.
package links

import (
	"context"
	"database/sql"
	"path"
	"sort"
	"strings"
	"unicode"
)

// Resolver resolves link targets against an in-memory snapshot of the index.
type Resolver struct {
	files   map[string]struct{} // every indexed file path
	byName  map[string][]string // lower-cased base name (without .md for notes) -> paths
	aliases map[string][]string // lower-cased alias -> note paths
	lowerFS map[string]string   // lower-cased path -> path
}

// File is an indexed file as far as resolution is concerned.
type File struct {
	Path    string
	Kind    string // "md" for notes; anything else keeps its extension in links
	Aliases []string
}

// NewResolver builds a resolver from an explicit file set (used to resolve
// against a hypothetical post-rename state).
func NewResolver(files []File) *Resolver {
	r := &Resolver{files: map[string]struct{}{}, byName: map[string][]string{}, aliases: map[string][]string{}, lowerFS: map[string]string{}}
	for _, f := range files {
		r.files[f.Path] = struct{}{}
		r.lowerFS[strings.ToLower(f.Path)] = f.Path
		base := path.Base(f.Path)
		if f.Kind == "md" {
			base = strings.TrimSuffix(base, path.Ext(base))
		}
		r.byName[strings.ToLower(base)] = append(r.byName[strings.ToLower(base)], f.Path)
		for _, a := range f.Aliases {
			r.aliases[strings.ToLower(a)] = append(r.aliases[strings.ToLower(a)], f.Path)
		}
	}
	return r
}

// LoadFiles reads the file set (with aliases) from index.db.
func LoadFiles(ctx context.Context, db *sql.DB) ([]File, error) {
	rows, err := db.QueryContext(ctx, `SELECT path, kind FROM files ORDER BY path`)
	if err != nil {
		return nil, err
	}
	var files []File
	idx := map[string]int{}
	for rows.Next() {
		var f File
		if err := rows.Scan(&f.Path, &f.Kind); err != nil {
			_ = rows.Close()
			return nil, err
		}
		idx[f.Path] = len(files)
		files = append(files, f)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	arows, err := db.QueryContext(ctx, `SELECT path, name FROM aliases`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = arows.Close() }()
	for arows.Next() {
		var p, name string
		if err := arows.Scan(&p, &name); err != nil {
			return nil, err
		}
		if i, ok := idx[p]; ok {
			files[i].Aliases = append(files[i].Aliases, name)
		}
	}
	return files, arows.Err()
}

// Load snapshots files and aliases from index.db.
func Load(ctx context.Context, db *sql.DB) (*Resolver, error) {
	files, err := LoadFiles(ctx, db)
	if err != nil {
		return nil, err
	}
	return NewResolver(files), nil
}

// Resolve returns the file a link written in fromPath points to, or "" when
// it is unresolved (a "ghost" note). target is the text before '#'/'|'.
// An empty target refers to fromPath itself ([[#Heading]]).
func (r *Resolver) Resolve(fromPath, target string) string {
	target = strings.TrimSpace(target)
	if target == "" {
		return fromPath
	}
	target = strings.TrimPrefix(target, "/")
	// 0. Explicitly relative paths ("./x", "../x") are resolved from the
	// source folder only.
	if strings.HasPrefix(target, "./") || strings.HasPrefix(target, "../") {
		joined := path.Clean(path.Join(path.Dir(fromPath), target))
		for _, cand := range []string{joined, joined + ".md"} {
			if p, ok := r.lowerFS[strings.ToLower(cand)]; ok {
				return p
			}
		}
		return ""
	}
	// 1. Exact vault path, with or without the .md extension.
	for _, cand := range []string{target, target + ".md"} {
		if p, ok := r.lowerFS[strings.ToLower(cand)]; ok {
			return p
		}
	}
	// 2. Relative to the source folder.
	if dir := path.Dir(fromPath); dir != "." {
		for _, cand := range []string{dir + "/" + target, dir + "/" + target + ".md"} {
			if p, ok := r.lowerFS[strings.ToLower(cand)]; ok {
				return p
			}
		}
	}
	// 3. Shortest path: match by name (or by trailing path segments).
	key := strings.ToLower(strings.TrimSuffix(path.Base(target), ".md"))
	if path.Ext(target) != "" && !strings.HasSuffix(strings.ToLower(target), ".md") {
		key = strings.ToLower(path.Base(target)) // attachments keep their extension
	}
	cands := r.byName[key]
	if strings.Contains(target, "/") {
		var filtered []string
		suffix := "/" + strings.ToLower(strings.TrimSuffix(target, ".md"))
		for _, c := range cands {
			lc := strings.ToLower(strings.TrimSuffix(c, ".md"))
			if strings.HasSuffix("/"+lc, suffix) {
				filtered = append(filtered, c)
			}
		}
		cands = filtered
	}
	if len(cands) == 0 {
		// 4. Alias of a note.
		cands = r.aliases[strings.ToLower(target)]
	}
	if len(cands) == 0 {
		return ""
	}
	return pickBest(fromPath, cands)
}

// pickBest prefers a candidate in the source folder, then the shortest path,
// then alphabetical order (deterministic).
func pickBest(from string, cands []string) string {
	dir := path.Dir(from)
	sorted := append([]string(nil), cands...)
	sort.Slice(sorted, func(i, j int) bool {
		si, sj := path.Dir(sorted[i]) == dir, path.Dir(sorted[j]) == dir
		if si != sj {
			return si
		}
		if len(sorted[i]) != len(sorted[j]) {
			return len(sorted[i]) < len(sorted[j])
		}
		return sorted[i] < sorted[j]
	})
	return sorted[0]
}

// ResolveAll fills links.target_resolved for every wikilink and Markdown
// link of the index (external URLs stay NULL). Call it after (re)indexing.
func ResolveAll(ctx context.Context, db *sql.DB) error {
	r, err := Load(ctx, db)
	if err != nil {
		return err
	}
	type row struct {
		rowid    int64
		src, raw string
	}
	rows, err := db.QueryContext(ctx, `SELECT rowid, path, target_raw FROM links WHERE kind <> 'external'`)
	if err != nil {
		return err
	}
	var todo []row
	for rows.Next() {
		var x row
		if err := rows.Scan(&x.rowid, &x.src, &x.raw); err != nil {
			_ = rows.Close()
			return err
		}
		todo = append(todo, x)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	stmt, err := tx.PrepareContext(ctx, `UPDATE links SET target_resolved = ? WHERE rowid = ?`)
	if err != nil {
		return err
	}
	defer func() { _ = stmt.Close() }()
	for _, x := range todo {
		var resolved any
		if p := r.Resolve(x.src, x.raw); p != "" {
			resolved = p
		}
		if _, err := stmt.ExecContext(ctx, resolved, x.rowid); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// Link is a link occurrence as shown in the UI.
type Link struct {
	Path     string `json:"path"` // note containing the link (backlinks) or target (outgoing)
	Line     int    `json:"line"`
	Raw      string `json:"raw"`     // target as written
	Heading  string `json:"heading"` // as written
	Block    string `json:"block"`   // as written
	Alias    string `json:"alias"`   // display text
	Embed    bool   `json:"embed"`
	Resolved bool   `json:"resolved"` // false = ghost note
}

// Outgoing lists the links written in a note, in source order.
func Outgoing(ctx context.Context, db *sql.DB, notePath string) ([]Link, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT COALESCE(target_resolved, ''), line, target_raw, heading, block, alias, embed
		FROM links WHERE path = ? AND kind <> 'external' ORDER BY line, rowid`, notePath)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []Link{}
	for rows.Next() {
		var l Link
		if err := rows.Scan(&l.Path, &l.Line, &l.Raw, &l.Heading, &l.Block, &l.Alias, &l.Embed); err != nil {
			return nil, err
		}
		l.Resolved = l.Path != ""
		out = append(out, l)
	}
	return out, rows.Err()
}

// Backlinks lists the links pointing at notePath from other notes (and the
// note itself, excluded) ordered by source path and line.
func Backlinks(ctx context.Context, db *sql.DB, notePath string) ([]Link, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT path, line, target_raw, heading, block, alias, embed
		FROM links WHERE target_resolved = ? AND path <> ? ORDER BY path, line, rowid`, notePath, notePath)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []Link{}
	for rows.Next() {
		l := Link{Resolved: true}
		if err := rows.Scan(&l.Path, &l.Line, &l.Raw, &l.Heading, &l.Block, &l.Alias, &l.Embed); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// Mention is an unlinked mention: another note whose text contains the
// title (or an alias) of notePath without linking to it.
type Mention struct {
	Path    string `json:"path"`
	Snippet string `json:"snippet"`
}

// UnlinkedMentions finds notes that mention notePath's title or aliases as
// plain text but do not link to it. Requires titles of 3+ characters (FTS
// trigram); shorter names yield no mentions.
func UnlinkedMentions(ctx context.Context, db *sql.DB, notePath string) ([]Mention, error) {
	var title string
	if err := db.QueryRowContext(ctx, `SELECT title FROM files WHERE path = ?`, notePath).Scan(&title); err != nil {
		return nil, err
	}
	names := []string{title}
	arows, err := db.QueryContext(ctx, `SELECT name FROM aliases WHERE path = ?`, notePath)
	if err != nil {
		return nil, err
	}
	for arows.Next() {
		var n string
		if err := arows.Scan(&n); err != nil {
			_ = arows.Close()
			return nil, err
		}
		names = append(names, n)
	}
	if err := arows.Close(); err != nil {
		return nil, err
	}

	seen := map[string]bool{}
	out := []Mention{}
	for _, name := range names {
		name = strings.TrimSpace(name)
		if len([]rune(name)) < 3 || !hasLetter(name) {
			continue
		}
		rows, err := db.QueryContext(ctx, `
			SELECT f.path, snippet(fts_content, 2, '', '', '…', 12)
			FROM fts_content f
			WHERE fts_content MATCH ? AND f.path <> ?
			  AND f.path NOT IN (SELECT path FROM links WHERE target_resolved = ?)
			ORDER BY f.path`, `body : "`+strings.ReplaceAll(name, `"`, `""`)+`"`, notePath, notePath)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var m Mention
			if err := rows.Scan(&m.Path, &m.Snippet); err != nil {
				_ = rows.Close()
				return nil, err
			}
			if !seen[m.Path] {
				seen[m.Path] = true
				out = append(out, m)
			}
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, nil
}

func hasLetter(s string) bool {
	for _, r := range s {
		if unicode.IsLetter(r) {
			return true
		}
	}
	return false
}
