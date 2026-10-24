package search

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"nodus/apps/desktop/internal/parser"
)

// Options tune a query.
type Options struct {
	Limit int    // default 100
	Sort  string // "relevance" (default) | "name" | "modified"
}

// Hit is one matching file.
type Hit struct {
	Path    string  `json:"path"`
	Title   string  `json:"title"`
	Snippet string  `json:"snippet"` // the first matching line, trimmed
	Line    int     `json:"line"`    // 1-based line of the snippet (0 if not line based)
	Matches int     `json:"matches"` // number of matches (relevance)
	Score   float64 `json:"score"`
}

// Results is the answer to a query.
type Results struct {
	Hits    []Hit    `json:"hits"`
	Total   int      `json:"total"`   // matching files before the limit
	Explain []string `json:"explain"` // human readable plan ("explain search terms")
}

// Engine evaluates queries on one vault index.
type Engine struct{ db *sql.DB }

// New binds an engine to index.db.
func New(db *sql.DB) *Engine { return &Engine{db: db} }

// Explain describes how a query is understood, without running it.
func Explain(q string) ([]string, error) {
	n, err := Parse(q)
	if err != nil {
		return nil, err
	}
	return []string{n.String()}, nil
}

// Query parses and runs q.
func (e *Engine) Query(ctx context.Context, q string, opts Options) (Results, error) {
	node, err := Parse(q)
	if err != nil {
		return Results{}, err
	}
	if opts.Limit <= 0 {
		opts.Limit = 100
	}
	res := Results{Hits: []Hit{}, Explain: []string{node.String()}}
	if and, ok := node.(And); ok && len(and.Items) == 0 {
		return res, nil // empty query
	}
	cands, err := e.candidates(ctx, node)
	if err != nil {
		return Results{}, err
	}
	var hits []Hit
	for _, c := range cands {
		if err := ctx.Err(); err != nil {
			return Results{}, err
		}
		f := &fileCtx{db: e.db, meta: c}
		ok, err := eval(ctx, node, f)
		if err != nil {
			return Results{}, err
		}
		if !ok {
			continue
		}
		h := Hit{Path: c.path, Title: c.title, Snippet: f.snippet, Line: f.snippetLine, Matches: f.matches}
		h.Score = float64(f.matches)
		hits = append(hits, h)
	}
	switch opts.Sort {
	case "name":
		sort.Slice(hits, func(i, j int) bool { return strings.ToLower(hits[i].Title) < strings.ToLower(hits[j].Title) })
	case "modified":
		mt := map[string]int64{}
		for _, c := range cands {
			mt[c.path] = c.mtime
		}
		sort.Slice(hits, func(i, j int) bool { return mt[hits[i].Path] > mt[hits[j].Path] })
	default:
		sort.SliceStable(hits, func(i, j int) bool {
			if hits[i].Score != hits[j].Score {
				return hits[i].Score > hits[j].Score
			}
			return hits[i].Path < hits[j].Path
		})
	}
	res.Total = len(hits)
	if len(hits) > opts.Limit {
		hits = hits[:opts.Limit]
	}
	res.Hits = hits
	return res, nil
}

type fileMeta struct {
	path, title, kind string
	mtime             int64
}

// candidates narrows the files to examine: when the query requires a text
// term of 3+ characters (top-level AND, case-insensitive) the FTS index
// provides the set; otherwise every file is a candidate.
func (e *Engine) candidates(ctx context.Context, n Node) ([]fileMeta, error) {
	var required []string
	collect := func(items []Node) {
		for _, it := range items {
			if p, ok := it.(Pred); ok && !p.CaseSensitive && (p.Op == "text" || p.Op == "content") {
				for _, t := range p.Terms {
					if len([]rune(t)) >= 3 {
						required = append(required, t)
					}
				}
			}
		}
	}
	switch v := n.(type) {
	case And:
		collect(v.Items)
	case Pred:
		collect([]Node{v})
	}
	query := `SELECT path, title, kind, mtime_ns FROM files`
	var args []any
	if len(required) > 0 {
		// Each required term must occur in title or body (trigram substring match).
		clauses := make([]string, len(required))
		for i, t := range required {
			clauses[i] = `path IN (SELECT path FROM fts_content WHERE fts_content MATCH ?)`
			args = append(args, `"`+strings.ReplaceAll(t, `"`, `""`)+`"`)
		}
		query += ` WHERE ` + strings.Join(clauses, " AND ") //nolint:gosec // clauses are constant fragments; user text is bound as parameters
	}
	query += ` ORDER BY path`
	rows, err := e.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []fileMeta
	for rows.Next() {
		var m fileMeta
		if err := rows.Scan(&m.path, &m.title, &m.kind, &m.mtime); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// fileCtx lazily loads what predicates need about one file.
type fileCtx struct {
	db   *sql.DB
	meta fileMeta

	bodyLoaded bool
	body       string
	lines      []string
	tagsLoaded bool
	tags       []string
	docLoaded  bool
	doc        parser.Document
	props      map[string]any

	snippet     string
	snippetLine int
	matches     int
}

func (f *fileCtx) loadBody(ctx context.Context) error {
	if f.bodyLoaded {
		return nil
	}
	f.bodyLoaded = true
	err := f.db.QueryRowContext(ctx, `SELECT body FROM fts_content WHERE rowid = (SELECT id FROM files WHERE path = ?)`, f.meta.path).Scan(&f.body)
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	f.lines = strings.Split(f.body, "\n")
	return nil
}

func (f *fileCtx) loadTags(ctx context.Context) error {
	if f.tagsLoaded {
		return nil
	}
	f.tagsLoaded = true
	rows, err := f.db.QueryContext(ctx, `SELECT name FROM tags WHERE path = ?`, f.meta.path)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return err
		}
		f.tags = append(f.tags, strings.ToLower(n))
	}
	return rows.Err()
}

func (f *fileCtx) loadDoc(ctx context.Context) error {
	if f.docLoaded {
		return nil
	}
	f.docLoaded = true
	if err := f.loadBody(ctx); err != nil {
		return err
	}
	f.doc = parser.Parse(f.meta.title, []byte(f.body))
	return nil
}

func (f *fileCtx) note(line int, text string, count int) {
	f.matches += count
	if f.snippet == "" {
		f.snippet, f.snippetLine = trimSnippet(text), line
	}
}

func trimSnippet(s string) string {
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > 160 {
		return string(r[:160]) + "…"
	}
	return s
}

func fold(s string, caseSensitive bool) string {
	if caseSensitive {
		return s
	}
	return strings.ToLower(s)
}

func eval(ctx context.Context, n Node, f *fileCtx) (bool, error) {
	switch v := n.(type) {
	case And:
		for _, it := range orderByCost(v.Items) {
			ok, err := eval(ctx, it, f)
			if err != nil || !ok {
				return false, err
			}
		}
		return true, nil
	case Or:
		matched := false
		for _, it := range v.Items {
			ok, err := eval(ctx, it, f)
			if err != nil {
				return false, err
			}
			matched = matched || ok
		}
		return matched, nil
	case Not:
		// A negation never contributes a snippet or relevance.
		saved := *f
		ok, err := eval(ctx, v.Item, f)
		f.snippet, f.snippetLine, f.matches = saved.snippet, saved.snippetLine, saved.matches
		return !ok, err
	case Pred:
		return evalPred(ctx, v, f)
	}
	return false, fmt.Errorf("unknown node %T", n)
}

// orderByCost evaluates cheap metadata predicates before ones needing the body.
func orderByCost(items []Node) []Node {
	out := append([]Node(nil), items...)
	cost := func(n Node) int {
		p, ok := n.(Pred)
		if !ok {
			return 3
		}
		switch p.Op {
		case "file", "path":
			return 0
		case "tag":
			return 1
		case "text", "content", "regex", "line":
			return 2
		}
		return 4
	}
	sort.SliceStable(out, func(i, j int) bool { return cost(out[i]) < cost(out[j]) })
	return out
}

func evalPred(ctx context.Context, p Pred, f *fileCtx) (bool, error) {
	switch p.Op {
	case "file":
		name := fold(baseName(f.meta.path), p.CaseSensitive)
		return allIn(name, p.Terms), nil
	case "path":
		return allIn(fold(f.meta.path, p.CaseSensitive), p.Terms), nil
	case "tag":
		if err := f.loadTags(ctx); err != nil {
			return false, err
		}
		for _, want := range p.Terms {
			want = strings.ToLower(want)
			found := false
			for _, t := range f.tags {
				if t == want || strings.HasPrefix(t, want+"/") {
					found = true
					break
				}
			}
			if !found {
				return false, nil
			}
		}
		return true, nil
	case "text":
		// A bare term matches the file name or the body.
		if allIn(fold(f.meta.title, p.CaseSensitive), p.Terms) {
			f.matches++
			return true, nil
		}
		return matchBody(ctx, p, f)
	case "content":
		return matchBody(ctx, p, f)
	case "regex":
		if err := f.loadBody(ctx); err != nil {
			return false, err
		}
		any := false
		for i, l := range f.lines {
			if n := len(p.Re.FindAllStringIndex(l, -1)); n > 0 {
				f.note(i+1, l, n)
				any = true
			}
		}
		return any, nil
	case "line":
		if err := f.loadBody(ctx); err != nil {
			return false, err
		}
		any := false
		for i, l := range f.lines {
			if allIn(fold(l, p.CaseSensitive), p.Terms) {
				f.note(i+1, l, 1)
				any = true
			}
		}
		return any, nil
	case "block", "section":
		return matchGroups(ctx, p, f)
	case "task", "task-todo", "task-done":
		if err := f.loadDoc(ctx); err != nil {
			return false, err
		}
		any := false
		for _, t := range f.doc.Tasks {
			done := t.State != " "
			if (p.Op == "task-todo" && done) || (p.Op == "task-done" && !done) {
				continue
			}
			if allIn(fold(t.Text, p.CaseSensitive), p.Terms) {
				f.note(t.Line, t.Text, 1)
				any = true
			}
		}
		return any, nil
	case "prop":
		if f.props == nil {
			if err := f.loadBody(ctx); err != nil {
				return false, err
			}
			f.props = parser.ParseProperties([]byte(f.body))
		}
		return matchProperty(f.props, p), nil
	}
	return false, fmt.Errorf("unknown predicate %q", p.Op)
}

func baseName(p string) string {
	if i := strings.LastIndexByte(p, '/'); i >= 0 {
		return p[i+1:]
	}
	return p
}

func allIn(hay string, terms []string) bool {
	for _, t := range terms {
		if !strings.Contains(hay, t) {
			return false
		}
	}
	return true
}

func matchBody(ctx context.Context, p Pred, f *fileCtx) (bool, error) {
	if err := f.loadBody(ctx); err != nil {
		return false, err
	}
	hay := fold(f.body, p.CaseSensitive)
	if !allIn(hay, p.Terms) {
		return false, nil
	}
	// Report the first line containing the first term, and count occurrences.
	for i, l := range f.lines {
		if strings.Contains(fold(l, p.CaseSensitive), p.Terms[0]) {
			f.note(i+1, l, strings.Count(hay, p.Terms[0]))
			break
		}
	}
	return true, nil
}

// matchGroups handles block: (paragraphs separated by blank lines) and
// section: (text between headings): all terms must occur in the same group.
func matchGroups(ctx context.Context, p Pred, f *fileCtx) (bool, error) {
	if err := f.loadBody(ctx); err != nil {
		return false, err
	}
	var group []string
	startLine := 1
	flush := func(end int) bool {
		text := strings.Join(group, "\n")
		ok := len(group) > 0 && allIn(fold(text, p.CaseSensitive), p.Terms)
		if ok {
			f.note(startLine, group[0], 1)
		}
		group, startLine = nil, end+1
		return ok
	}
	found := false
	for i, l := range f.lines {
		boundary := strings.TrimSpace(l) == ""
		if p.Op == "section" {
			boundary = strings.HasPrefix(strings.TrimLeft(l, " "), "#") && len(group) > 0
		}
		if boundary {
			end := i
			if p.Op == "section" {
				end = i - 1
			}
			found = flush(end) || found
			if p.Op == "section" {
				group, startLine = []string{l}, i+1
			}
			continue
		}
		if len(group) == 0 {
			startLine = i + 1
		}
		group = append(group, l)
	}
	found = flush(len(f.lines)) || found
	return found, nil
}

// matchProperty evaluates [name], [name:value] and [name:<value] filters.
func matchProperty(props map[string]any, p Pred) bool {
	var val any
	var present bool
	for k, v := range props {
		if strings.ToLower(k) == p.Prop {
			val, present = v, true
			break
		}
	}
	if !present {
		return false
	}
	if p.Cmp == "" {
		return true
	}
	// A list matches when any element matches.
	if list, ok := val.([]any); ok {
		for _, el := range list {
			if compareValue(el, p.Cmp, p.Value) {
				return true
			}
		}
		return false
	}
	return compareValue(val, p.Cmp, p.Value)
}

func compareValue(v any, cmp, want string) bool {
	switch x := v.(type) {
	case bool:
		return cmp == "=" && strings.EqualFold(strconv.FormatBool(x), want)
	case int:
		return compareFloat(float64(x), cmp, want)
	case int64:
		return compareFloat(float64(x), cmp, want)
	case float64:
		return compareFloat(x, cmp, want)
	case time.Time:
		return compareString(x.Format("2006-01-02"), cmp, want)
	case string:
		if cmp == "=" {
			return strings.Contains(strings.ToLower(x), strings.ToLower(want))
		}
		// ISO dates and plain strings compare lexicographically.
		if f, err := strconv.ParseFloat(x, 64); err == nil {
			return compareFloat(f, cmp, want)
		}
		return compareString(x, cmp, want)
	case nil:
		return false
	}
	return compareString(fmt.Sprint(v), cmp, want)
}

func compareFloat(a float64, cmp, want string) bool {
	b, err := strconv.ParseFloat(want, 64)
	if err != nil {
		return false
	}
	switch cmp {
	case "=":
		return a == b
	case "<":
		return a < b
	case ">":
		return a > b
	case "<=":
		return a <= b
	case ">=":
		return a >= b
	}
	return false
}

func compareString(a, cmp, want string) bool {
	switch cmp {
	case "=":
		return strings.EqualFold(a, want)
	case "<":
		return a < want
	case ">":
		return a > want
	case "<=":
		return a <= want
	case ">=":
		return a >= want
	}
	return false
}
