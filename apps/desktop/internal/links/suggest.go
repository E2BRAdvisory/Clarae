package links

import (
	"context"
	"database/sql"
	"path"
	"sort"
	"strings"
	"unicode"
)

// Suggestion is one completion or quick-switcher candidate.
type Suggestion struct {
	// note | alias | heading | block | tag | property; SuggestFiles adds the files that are not
	// notes: webapp | canvas | base | drawing (see FileSuggestionKinds).
	Kind   string `json:"kind"`
	Label  string `json:"label"`  // text to show and to insert
	Path   string `json:"path"`   // note the suggestion belongs to ("" for tags and properties)
	Detail string `json:"detail"` // secondary text: folder, alias target, heading level, block text
	Line   int    `json:"line"`   // headings and blocks: line in the note
	Score  int    `json:"score"`
}

// FuzzyScore ranks how well query matches text; 0 means no match. Exact >
// prefix > word prefix > substring > subsequence (all case-insensitive).
func FuzzyScore(query, text string) int {
	q, t := strings.ToLower(strings.TrimSpace(query)), strings.ToLower(text)
	switch {
	case q == "":
		return 1
	case t == q:
		return 1000
	case strings.HasPrefix(t, q):
		return 800 - min(len(t)-len(q), 100)
	}
	// Word-prefix: any word of text starts with the query.
	for _, f := range strings.FieldsFunc(t, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) }) {
		if strings.HasPrefix(f, q) {
			return 600 - min(len(t)-len(q), 100)
		}
	}
	if i := strings.Index(t, q); i >= 0 {
		return 400 - min(i, 100)
	}
	// Subsequence: characters of q appear in order in t.
	ti, gaps := 0, 0
	tr := []rune(t)
	for _, c := range q {
		found := false
		for ti < len(tr) {
			if tr[ti] == c {
				found = true
				ti++
				break
			}
			ti++
			gaps++
		}
		if !found {
			return 0
		}
	}
	return max(1, 200-min(gaps, 190))
}

// SuggestNotes lists notes (by title, path and alias) matching query, best first.
func SuggestNotes(ctx context.Context, db *sql.DB, query string, limit int) ([]Suggestion, error) {
	out, err := suggestFiles(ctx, db, query, false)
	if err != nil {
		return nil, err
	}
	return rank(out, limit), nil
}

// notHidden is the condition of files.path that the file explorer applies: no segment of the path
// starts with a dot (.trash/, .obsidian/, .clarae/ ...). Such a file can be opened (from the trash,
// for one) but is not something to offer by name. In SQL: LIKE has no wildcard in the dot.
const notHidden = `path NOT LIKE '.%' AND path NOT LIKE '%/.%'`

// suggestFiles is the unranked list of notes and aliases matching query and, with others, of the
// applications, whiteboards, bases and drawings too, in one pass over the index.
func suggestFiles(ctx context.Context, db *sql.DB, query string, others bool) ([]Suggestion, error) {
	where := `kind = 'md'`
	if others {
		where = `kind IN ('md', 'canvas', 'base', 'excalidraw') OR (kind = 'other' AND lower(path) LIKE '%.webapp')`
	}
	rows, err := db.QueryContext(ctx, `SELECT path, kind, title FROM files WHERE (`+where+`) AND `+notHidden)
	if err != nil {
		return nil, err
	}
	var out []Suggestion
	for rows.Next() {
		var p, kind, title string
		if err := rows.Scan(&p, &kind, &title); err != nil {
			_ = rows.Close()
			return nil, err
		}
		k := "note"
		if kind != "md" {
			if k = openableKind(kind, p); k == "" {
				continue
			}
			title = path.Base(p)
			title = strings.TrimSuffix(title, path.Ext(title)) // the extension in whatever case it has
		}
		s := FuzzyScore(query, title)
		if s2 := FuzzyScore(query, p) / 2; s2 > s {
			s = s2
		}
		if s > 0 {
			out = append(out, Suggestion{Kind: k, Label: title, Path: p, Detail: dirOf(p), Score: s})
		}
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	arows, err := db.QueryContext(ctx, `SELECT path, name FROM aliases WHERE `+notHidden)
	if err != nil {
		return nil, err
	}
	for arows.Next() {
		var p, name string
		if err := arows.Scan(&p, &name); err != nil {
			_ = arows.Close()
			return nil, err
		}
		if s := FuzzyScore(query, name); s > 0 {
			out = append(out, Suggestion{Kind: "alias", Label: name, Path: p, Detail: strings.TrimSuffix(path.Base(p), ".md"), Score: s})
		}
	}
	if err := arows.Close(); err != nil {
		return nil, err
	}
	return out, nil
}

// File kinds SuggestFiles reports besides "note" (a .md or .marp file, as for SuggestNotes) and
// "alias". They are Suggestion.Kind values the UI uses to tell the files apart in the quick switcher.
const (
	KindWebapp  = "webapp"  // an application: a .webapp file (M18)
	KindCanvas  = "canvas"  // a whiteboard (.canvas)
	KindBase    = "base"    // a database view (.base)
	KindDrawing = "drawing" // an Excalidraw drawing (.excalidraw)
)

// SuggestFiles is the candidate list of the quick switcher: everything SuggestNotes lists (notes,
// presentations and aliases) plus the files the application opens in a tab that are not Markdown:
// applications, whiteboards, bases and drawings, by file name without the extension and by path.
// They are searched here and not in SuggestNotes because that one feeds the completion of a
// wikilink and the "insert a note" pickers, where a link to an application or a base makes no sense;
// the quick switcher only opens things. Presentations (.marp) are Markdown for the index (kind
// 'md') so SuggestNotes already lists them. An application has no index kind of its own: the
// index files it as 'other', like any file the application does not know, so it is recognized by
// its extension and not every 'other' file (a .txt, a .zip) enters the list. Files in a hidden
// folder (.trash, .obsidian) are left out, as in the file explorer; so are they in SuggestNotes.
func SuggestFiles(ctx context.Context, db *sql.DB, query string, limit int) ([]Suggestion, error) {
	out, err := suggestFiles(ctx, db, query, true)
	if err != nil {
		return nil, err
	}
	return rank(out, limit), nil
}

// openableKind is the Suggestion.Kind of a file that is not Markdown, or "" when the quick switcher
// does not list it.
func openableKind(indexKind, p string) string {
	switch indexKind {
	case "canvas":
		return KindCanvas
	case "base":
		return KindBase
	case "excalidraw":
		return KindDrawing
	case "other":
		if strings.EqualFold(path.Ext(p), ".webapp") {
			return KindWebapp
		}
	}
	return ""
}

func dirOf(p string) string {
	if dir := path.Dir(p); dir != "." {
		return dir
	}
	return ""
}

// SuggestHeadings lists the headings of a note matching query. With an empty
// notePath, headings of every note are searched (Note#Heading in the switcher).
func SuggestHeadings(ctx context.Context, db *sql.DB, notePath, query string, limit int) ([]Suggestion, error) {
	q := `SELECT path, text, level, line FROM headings`
	var args []any
	if notePath != "" {
		q += ` WHERE path = ?`
		args = append(args, notePath)
	}
	q += ` ORDER BY path, line`
	rows, err := db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []Suggestion
	for rows.Next() {
		var p, text string
		var level, line int
		if err := rows.Scan(&p, &text, &level, &line); err != nil {
			return nil, err
		}
		if s := FuzzyScore(query, plainHeading(text)); s > 0 {
			out = append(out, Suggestion{Kind: "heading", Label: plainHeading(text), Path: p, Detail: strings.Repeat("#", level), Line: line, Score: s})
		}
	}
	return rank(out, limit), rows.Err()
}

// SuggestBlocks lists block ids of a note with the text of their line.
func SuggestBlocks(ctx context.Context, db *sql.DB, notePath, query string, limit int) ([]Suggestion, error) {
	var body string
	if err := db.QueryRowContext(ctx, `SELECT body FROM fts_content WHERE rowid = (SELECT id FROM files WHERE path = ?)`, notePath).Scan(&body); err != nil && err != sql.ErrNoRows {
		return nil, err
	}
	lines := strings.Split(body, "\n")
	rows, err := db.QueryContext(ctx, `SELECT line, id FROM block_ids WHERE path = ? ORDER BY line`, notePath)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []Suggestion
	for rows.Next() {
		var line int
		var id string
		if err := rows.Scan(&line, &id); err != nil {
			return nil, err
		}
		text := ""
		if line >= 1 && line <= len(lines) {
			text = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(lines[line-1]), "^"+id))
		}
		if s := max(FuzzyScore(query, id), FuzzyScore(query, text)); s > 0 {
			out = append(out, Suggestion{Kind: "block", Label: id, Path: notePath, Detail: text, Line: line, Score: s})
		}
	}
	return rank(out, limit), rows.Err()
}

// SuggestTags lists tags (with usage count in Detail) matching query.
func SuggestTags(ctx context.Context, db *sql.DB, query string, limit int) ([]Suggestion, error) {
	rows, err := db.QueryContext(ctx, `SELECT name, count(DISTINCT path) FROM tags GROUP BY name`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []Suggestion
	for rows.Next() {
		var name string
		var n int
		if err := rows.Scan(&name, &n); err != nil {
			return nil, err
		}
		if s := FuzzyScore(strings.TrimPrefix(query, "#"), name); s > 0 {
			out = append(out, Suggestion{Kind: "tag", Label: name, Detail: itoa(n), Score: s + min(n, 50)})
		}
	}
	return rank(out, limit), rows.Err()
}

// SuggestPropertyKeys lists frontmatter property names in use.
func SuggestPropertyKeys(ctx context.Context, db *sql.DB, query string, limit int) ([]Suggestion, error) {
	rows, err := db.QueryContext(ctx, `SELECT key, kind, count(*) FROM properties GROUP BY lower(key)`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []Suggestion
	for rows.Next() {
		var key, kind string
		var n int
		if err := rows.Scan(&key, &kind, &n); err != nil {
			return nil, err
		}
		if s := FuzzyScore(query, key); s > 0 {
			out = append(out, Suggestion{Kind: "property", Label: key, Detail: kind, Score: s + min(n, 50)})
		}
	}
	return rank(out, limit), rows.Err()
}

func rank(s []Suggestion, limit int) []Suggestion {
	if s == nil {
		return []Suggestion{}
	}
	sort.SliceStable(s, func(i, j int) bool {
		if s[i].Score != s[j].Score {
			return s[i].Score > s[j].Score
		}
		if s[i].Label != s[j].Label {
			return strings.ToLower(s[i].Label) < strings.ToLower(s[j].Label)
		}
		return s[i].Path < s[j].Path
	})
	if limit > 0 && len(s) > limit {
		s = s[:limit]
	}
	return s
}

// plainHeading strips the Markdown a heading may carry so it matches what the user sees.
func plainHeading(s string) string {
	r := strings.NewReplacer("**", "", "__", "", "`", "", "[[", "", "]]", "", "==", "")
	s = strings.TrimSpace(r.Replace(s))
	if i := strings.LastIndex(s, " ^"); i >= 0 && !strings.ContainsAny(s[i+2:], " \t") {
		s = strings.TrimSpace(s[:i]) // trailing block id
	}
	return s
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}
