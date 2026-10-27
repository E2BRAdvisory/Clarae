package search

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"memobrain/apps/desktop/internal/parser"
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
type Engine struct {
	db *sql.DB
	c  *cache // shared by every Engine of the same database (see cache.go)
}

// New binds an engine to index.db.
func New(db *sql.DB) *Engine { return &Engine{db: db, c: cacheFor(db)} }

// Explain describes how a query is understood, without running it.
func Explain(q string) ([]string, error) {
	n, err := Parse(q)
	if err != nil {
		return nil, err
	}
	return []string{n.String()}, nil
}

// queryer is what predicates need from the database: the read transaction of
// the running query (one snapshot, one connection acquisition for the whole
// query instead of one per file).
type queryer interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// Query parses and runs q.
//
// Performance notes (M7-WP1, ADR-0020): candidates come from the in-memory
// cache (cache.go) and are evaluated on all cores; above the cache budget the
// query runs in a single read transaction streaming candidate rows (with the
// body when a predicate needs it) out of one SQL statement. Loading each body
// with its own statement cost one WAL read-lock round trip per file and made
// 50,000 notes take seconds. Results and their order are unchanged.
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
	var hits []found
	snap, err := e.snapshot(ctx)
	if err != nil {
		return Results{}, err
	}
	if snap != nil {
		if hits, err = evalSnapshot(ctx, snap, node); err != nil {
			return Results{}, err
		}
	} else if hits, err = e.queryStreaming(ctx, node); err != nil {
		return Results{}, err
	}
	switch opts.Sort {
	case "name":
		sort.Slice(hits, func(i, j int) bool { return strings.ToLower(hits[i].hit.Title) < strings.ToLower(hits[j].hit.Title) })
	case "modified":
		sort.Slice(hits, func(i, j int) bool { return hits[i].mtime > hits[j].mtime })
	default:
		sort.SliceStable(hits, func(i, j int) bool {
			if hits[i].hit.Score != hits[j].hit.Score {
				return hits[i].hit.Score > hits[j].hit.Score
			}
			return hits[i].hit.Path < hits[j].hit.Path
		})
	}
	res.Total = len(hits)
	if len(hits) > opts.Limit {
		hits = hits[:opts.Limit]
	}
	for _, h := range hits {
		res.Hits = append(res.Hits, h.hit)
	}
	return res, nil
}

// found is a matching file with the data the sort orders need.
type found struct {
	hit   Hit
	mtime int64
}

// queryStreaming evaluates the query reading candidates out of index.db (no cache).
func (e *Engine) queryStreaming(ctx context.Context, node Node) ([]found, error) {
	tx, err := e.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	var hits []found
	err = e.scan(ctx, tx, node, func(c fileMeta, body *string) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		f := &fileCtx{db: tx, meta: c}
		if body != nil {
			f.body, f.bodyLoaded = *body, true
		}
		ok, err := eval(ctx, node, f)
		if err != nil || !ok {
			return err
		}
		h := Hit{Path: c.path, Title: c.title, Snippet: f.snippet, Line: f.snippetLine, Matches: f.matches}
		h.Score = float64(f.matches)
		hits = append(hits, found{hit: h, mtime: c.mtime})
		return nil
	})
	return hits, err
}

type fileMeta struct {
	path, title, kind string
	mtime             int64
}

// requiredTerms are the text terms (3+ characters, case-insensitive) every
// matching file must contain in its title or body: the FTS index narrows the
// candidates to files containing all of them.
func requiredTerms(n Node) []string {
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
	return required
}

// needsBody reports whether evaluating n may read the note text; queries on
// file name, path and tags only never load it.
func needsBody(n Node) bool {
	switch v := n.(type) {
	case And:
		for _, it := range v.Items {
			if needsBody(it) {
				return true
			}
		}
		return false
	case Or:
		for _, it := range v.Items {
			if needsBody(it) {
				return true
			}
		}
		return false
	case Not:
		return needsBody(v.Item)
	case Pred:
		return v.Op != "file" && v.Op != "path" && v.Op != "tag"
	}
	return true
}

// scan streams the candidate files in path order: when the query requires a
// text term of 3+ characters the FTS index provides the set, otherwise every
// file is a candidate. body is nil when no predicate needs it.
func (e *Engine) scan(ctx context.Context, q queryer, n Node, fn func(m fileMeta, body *string) error) error {
	withBody := needsBody(n)
	query := `SELECT f.path, f.title, f.kind, f.mtime_ns`
	if withBody {
		query += `, COALESCE(c.body, '')`
	}
	query += ` FROM files f`
	if withBody {
		query += ` LEFT JOIN fts_content c ON c.rowid = f.id`
	}
	var args []any
	if required := requiredTerms(n); len(required) > 0 {
		// Each required term must occur in title or body (trigram substring match).
		clauses := make([]string, len(required))
		for i, t := range required {
			clauses[i] = `f.id IN (SELECT rowid FROM fts_content WHERE fts_content MATCH ?)`
			args = append(args, `"`+strings.ReplaceAll(t, `"`, `""`)+`"`)
		}
		query += ` WHERE ` + strings.Join(clauses, " AND ")
	}
	query += ` ORDER BY f.path`
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var m fileMeta
		var body string
		dest := []any{&m.path, &m.title, &m.kind, &m.mtime}
		if withBody {
			dest = append(dest, &body)
		}
		if err := rows.Scan(dest...); err != nil {
			return err
		}
		var bp *string
		if withBody {
			bp = &body
		}
		if err := fn(m, bp); err != nil {
			return err
		}
	}
	return rows.Err()
}

// fileCtx lazily loads what predicates need about one file.
type fileCtx struct {
	db   queryer
	meta fileMeta

	bodyLoaded bool
	body       string
	foldedBody string
	foldDone   bool
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
	return nil
}

// folded returns the body folded for a case-insensitive comparison, computed once per file.
func (f *fileCtx) folded(caseSensitive bool) string {
	if caseSensitive {
		return f.body
	}
	if !f.foldDone {
		f.foldedBody, f.foldDone = strings.ToLower(f.body), true
	}
	return f.foldedBody
}

// getLines splits the body once, on first use (most notes are rejected before it is needed).
func (f *fileCtx) getLines() []string {
	if f.lines == nil {
		f.lines = strings.Split(f.body, "\n")
	}
	return f.lines
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
		for i, l := range f.getLines() {
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
		for i, l := range f.getLines() {
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
	hay := f.folded(p.CaseSensitive)
	if !allIn(hay, p.Terms) {
		return false, nil
	}
	// Report the first line containing the first term, and count occurrences.
	first := p.Terms[0]
	if i := strings.Index(hay, first); i >= 0 && len(hay) == len(f.body) {
		// Folding kept the byte length, so offsets in hay are offsets in the body: the line is
		// cut out of it directly instead of folding and testing every line.
		line := strings.Count(hay[:i], "\n") + 1
		start := strings.LastIndexByte(f.body[:i], '\n') + 1
		end := len(f.body)
		if j := strings.IndexByte(f.body[i:], '\n'); j >= 0 {
			end = i + j
		}
		f.note(line, f.body[start:end], strings.Count(hay, first))
		return true, nil
	}
	for i, l := range f.getLines() {
		if strings.Contains(fold(l, p.CaseSensitive), first) {
			f.note(i+1, l, strings.Count(hay, first))
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
	for i, l := range f.getLines() {
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
	found = flush(len(f.getLines())) || found
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
