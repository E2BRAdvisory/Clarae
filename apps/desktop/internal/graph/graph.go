// Package graph builds the node/edge data behind the Graph view (§2.5
// "graph"). It reads the derived index (index.db) only: layout is computed by
// the frontend. Every call issues a fixed number of queries (no per-note
// lookups), so it scales to tens of thousands of notes.
package graph

import (
	"context"
	"database/sql"
	"encoding/json"
	"sort"
	"strings"
	"time"

	"nodus/apps/desktop/internal/search"
)

// Node kinds.
const (
	KindNote       = "note"
	KindGhost      = "ghost"
	KindAttachment = "attachment"
	KindTag        = "tag"
)

// Directions of a local graph.
const (
	DirBoth = "both"
	DirIn   = "in"
	DirOut  = "out"
)

// DefaultMaxNodes caps the size of an answer; beyond it the best connected
// nodes are kept and Graph.Truncated is set.
const DefaultMaxNodes = 20000

// Options select what the graph contains.
type Options struct {
	// Query is a search-language query (§2.4); only matching files are shown.
	Query string `json:"query"`
	// Tags keeps files carrying at least one of the tags (nested tags match by prefix).
	Tags []string `json:"tags"`
	// Folders keeps files under at least one of these vault folders; ExcludeFolders removes files under any of them.
	Folders        []string `json:"folders"`
	ExcludeFolders []string `json:"excludeFolders"`
	// ShowOrphans keeps nodes without any visible edge.
	ShowOrphans bool `json:"showOrphans"`
	// ShowGhosts adds unresolved link targets as ghost nodes.
	ShowGhosts      bool `json:"showGhosts"`
	ShowAttachments bool `json:"showAttachments"`
	ShowTags        bool `json:"showTags"`
	// Center, Depth and Direction restrict the graph to the neighbourhood of one file (local graph).
	Center    string `json:"center"`
	Depth     int    `json:"depth"`
	Direction string `json:"direction"`
	// Groups are search queries; Node.Groups lists the indexes of those a node matches.
	Groups []string `json:"groups"`
	// MaxNodes caps the answer (default DefaultMaxNodes).
	MaxNodes int `json:"maxNodes"`
}

// Node is a vertex of the graph.
type Node struct {
	ID    string `json:"id"` // path for files, "ghost:<name>" / "tag:<name>" otherwise
	Label string `json:"label"`
	Kind  string `json:"kind"`
	// Path is the vault path of a note or attachment ("" for ghosts and tags).
	Path   string `json:"path"`
	Degree int    `json:"degree"`
	// Created is the creation time in Unix milliseconds: the frontmatter
	// "created" property when present, otherwise the indexed modification time
	// (the index does not store file birth time). 0 for ghosts and tags.
	Created int64 `json:"created"`
	Groups  []int `json:"groups,omitempty"`
}

// Edge joins two nodes, given as indexes into Graph.Nodes; it is directed from the linking note.
type Edge struct {
	Source int `json:"source"`
	Target int `json:"target"`
}

// Graph is the answer of Build.
type Graph struct {
	Nodes []Node `json:"nodes"`
	Edges []Edge `json:"edges"`
	// Truncated is true when MaxNodes dropped nodes.
	Truncated bool `json:"truncated"`
	// Total is the number of nodes before truncation.
	Total int `json:"total"`
}

type file struct {
	path, title, kind string
	mtime             int64 // ns
	created           int64 // ms, 0 when the frontmatter has no usable date
	tags              []string
}

// Build computes the graph of a vault index.
func Build(ctx context.Context, db *sql.DB, o Options) (Graph, error) {
	if o.MaxNodes <= 0 {
		o.MaxNodes = DefaultMaxNodes
	}
	files, err := loadFiles(ctx, db)
	if err != nil {
		return Graph{}, err
	}
	if o.ShowTags || len(o.Tags) > 0 {
		if err := loadTags(ctx, db, files); err != nil {
			return Graph{}, err
		}
	}
	if err := loadCreated(ctx, db, files); err != nil {
		return Graph{}, err
	}

	var queryMatch map[string]bool
	if strings.TrimSpace(o.Query) != "" {
		if queryMatch, err = matchSet(ctx, db, o.Query); err != nil {
			return Graph{}, err
		}
	}
	tagWant := normalizeTags(o.Tags)
	visible := func(f *file) bool {
		if f.kind == "attachment" && !o.ShowAttachments {
			return false
		}
		if queryMatch != nil && !queryMatch[f.path] {
			return false
		}
		if len(o.Folders) > 0 && !underAny(f.path, o.Folders) {
			return false
		}
		if underAny(f.path, o.ExcludeFolders) {
			return false
		}
		return len(tagWant) == 0 || hasAnyTag(f.tags, tagWant)
	}

	// Deterministic node order: by path.
	paths := make([]string, 0, len(files))
	for p := range files {
		paths = append(paths, p)
	}
	sort.Strings(paths)

	b := &builder{index: map[string]int{}}
	for _, p := range paths {
		f := files[p]
		if !visible(f) {
			continue
		}
		kind := KindNote
		if f.kind == "attachment" {
			kind = KindAttachment
		}
		created := f.mtime / int64(time.Millisecond)
		if f.created != 0 {
			created = f.created
		}
		b.add(Node{ID: f.path, Label: f.title, Kind: kind, Path: f.path, Created: created})
	}

	if err := b.addLinks(ctx, db, o.ShowGhosts); err != nil {
		return Graph{}, err
	}
	if o.ShowTags {
		for _, p := range paths {
			f := files[p]
			src, ok := b.index[p]
			if !ok || f.kind != "md" {
				continue
			}
			seen := map[string]bool{}
			for _, t := range f.tags {
				if !seen[t] {
					seen[t] = true
					b.edge(src, b.addAux("tag:"+t, "#"+t, KindTag))
				}
			}
		}
	}

	keep := make([]bool, len(b.nodes))
	for i := range keep {
		keep[i] = true
	}
	if o.Center != "" {
		c, ok := b.index[o.Center]
		if !ok {
			return Graph{Nodes: []Node{}, Edges: []Edge{}}, nil
		}
		keep = b.neighbourhood(c, o.Depth, o.Direction)
	}

	deg := make([]int, len(b.nodes))
	for _, e := range b.edges {
		if keep[e.Source] && keep[e.Target] {
			deg[e.Source]++
			deg[e.Target]++
		}
	}
	for i := range keep {
		if keep[i] && deg[i] == 0 && !o.ShowOrphans && (o.Center == "" || b.nodes[i].ID != o.Center) {
			keep[i] = false
		}
	}

	total := 0
	for _, k := range keep {
		if k {
			total++
		}
	}
	truncated := total > o.MaxNodes
	if truncated {
		ids := make([]int, 0, total)
		for i, k := range keep {
			if k {
				ids = append(ids, i)
			}
		}
		sort.SliceStable(ids, func(x, y int) bool { return deg[ids[x]] > deg[ids[y]] })
		for _, i := range ids[o.MaxNodes:] {
			keep[i] = false
		}
	}

	remap := make([]int, len(b.nodes))
	out := Graph{Nodes: make([]Node, 0, total), Edges: []Edge{}, Truncated: truncated, Total: total}
	for i, k := range keep {
		if !k {
			remap[i] = -1
			continue
		}
		remap[i] = len(out.Nodes)
		out.Nodes = append(out.Nodes, b.nodes[i])
	}
	for _, e := range b.edges {
		if s, t := remap[e.Source], remap[e.Target]; s >= 0 && t >= 0 {
			out.Edges = append(out.Edges, Edge{s, t})
		}
	}
	for _, e := range out.Edges {
		out.Nodes[e.Source].Degree++
		out.Nodes[e.Target].Degree++
	}

	for gi, q := range o.Groups {
		if strings.TrimSpace(q) == "" {
			continue
		}
		set, err := matchSet(ctx, db, q)
		if err != nil {
			return Graph{}, err
		}
		for i := range out.Nodes {
			if out.Nodes[i].Path != "" && set[out.Nodes[i].Path] {
				out.Nodes[i].Groups = append(out.Nodes[i].Groups, gi)
			}
		}
	}
	return out, nil
}

type builder struct {
	nodes []Node
	edges []Edge
	index map[string]int
	seen  map[[2]int]struct{}
}

func (b *builder) add(n Node) int {
	b.index[n.ID] = len(b.nodes)
	b.nodes = append(b.nodes, n)
	return len(b.nodes) - 1
}

func (b *builder) addAux(id, label, kind string) int {
	if i, ok := b.index[id]; ok {
		return i
	}
	return b.add(Node{ID: id, Label: label, Kind: kind})
}

func (b *builder) edge(s, t int) {
	if s == t {
		return
	}
	if b.seen == nil {
		b.seen = map[[2]int]struct{}{}
	}
	k := [2]int{s, t}
	if _, dup := b.seen[k]; dup {
		return
	}
	b.seen[k] = struct{}{}
	b.edges = append(b.edges, Edge{s, t})
}

// addLinks scans the links table once. Only notes are link sources.
func (b *builder) addLinks(ctx context.Context, db *sql.DB, ghosts bool) error {
	rows, err := db.QueryContext(ctx, `SELECT path, target_resolved, target_raw FROM links WHERE kind != 'external'`)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var src, raw string
		var resolved sql.NullString
		if err := rows.Scan(&src, &resolved, &raw); err != nil {
			return err
		}
		si, ok := b.index[src]
		if !ok || b.nodes[si].Kind != KindNote {
			continue
		}
		if resolved.Valid && resolved.String != "" {
			if ti, ok := b.index[resolved.String]; ok {
				b.edge(si, ti)
			}
			continue
		}
		if !ghosts {
			continue
		}
		name := strings.TrimSpace(raw)
		if i := strings.IndexAny(name, "#|"); i >= 0 {
			name = strings.TrimSpace(name[:i])
		}
		if name == "" {
			continue
		}
		b.edge(si, b.addAux("ghost:"+strings.ToLower(name), name, KindGhost))
	}
	return rows.Err()
}

// neighbourhood marks the nodes within depth hops of c following direction.
func (b *builder) neighbourhood(c, depth int, dir string) []bool {
	if depth < 1 {
		depth = 1
	}
	out := make([][]int, len(b.nodes))
	in := make([][]int, len(b.nodes))
	for _, e := range b.edges {
		out[e.Source] = append(out[e.Source], e.Target)
		in[e.Target] = append(in[e.Target], e.Source)
	}
	keep := make([]bool, len(b.nodes))
	keep[c] = true
	frontier := []int{c}
	for d := 0; d < depth && len(frontier) > 0; d++ {
		var next []int
		for _, n := range frontier {
			var adj [][]int
			switch dir {
			case DirOut:
				adj = [][]int{out[n]}
			case DirIn:
				adj = [][]int{in[n]}
			default:
				adj = [][]int{out[n], in[n]}
			}
			for _, l := range adj {
				for _, m := range l {
					if !keep[m] {
						keep[m] = true
						next = append(next, m)
					}
				}
			}
		}
		frontier = next
	}
	return keep
}

func loadFiles(ctx context.Context, db *sql.DB) (map[string]*file, error) {
	rows, err := db.QueryContext(ctx, `SELECT path, kind, title, mtime_ns FROM files WHERE kind IN ('md','attachment')`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := map[string]*file{}
	for rows.Next() {
		f := &file{}
		if err := rows.Scan(&f.path, &f.kind, &f.title, &f.mtime); err != nil {
			return nil, err
		}
		out[f.path] = f
	}
	return out, rows.Err()
}

func loadTags(ctx context.Context, db *sql.DB, files map[string]*file) error {
	rows, err := db.QueryContext(ctx, `SELECT path, name FROM tags`)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var p, n string
		if err := rows.Scan(&p, &n); err != nil {
			return err
		}
		if f, ok := files[p]; ok {
			f.tags = append(f.tags, strings.ToLower(n))
		}
	}
	return rows.Err()
}

var createdLayouts = []string{time.RFC3339, "2006-01-02T15:04:05", "2006-01-02T15:04", "2006-01-02 15:04:05", "2006-01-02 15:04", "2006-01-02"}

// loadCreated reads the frontmatter "created" property (one query).
func loadCreated(ctx context.Context, db *sql.DB, files map[string]*file) error {
	rows, err := db.QueryContext(ctx, `SELECT path, value FROM properties WHERE lower(key) IN ('created','date created','creation date')`)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var p, v string
		if err := rows.Scan(&p, &v); err != nil {
			return err
		}
		f, ok := files[p]
		if !ok {
			continue
		}
		var s string
		if json.Unmarshal([]byte(v), &s) != nil {
			continue
		}
		for _, l := range createdLayouts {
			if t, err := time.ParseInLocation(l, strings.TrimSpace(s), time.Local); err == nil {
				f.created = t.UnixMilli()
				break
			}
		}
	}
	return rows.Err()
}

func matchSet(ctx context.Context, db *sql.DB, q string) (map[string]bool, error) {
	res, err := search.New(db).Query(ctx, q, search.Options{Limit: 1 << 30, Sort: "name"})
	if err != nil {
		return nil, err
	}
	set := make(map[string]bool, len(res.Hits))
	for _, h := range res.Hits {
		set[h.Path] = true
	}
	return set, nil
}

func normalizeTags(in []string) []string {
	var out []string
	for _, t := range in {
		t = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(t), "#"))
		if t != "" {
			out = append(out, t)
		}
	}
	return out
}

func hasAnyTag(have, want []string) bool {
	for _, h := range have {
		for _, w := range want {
			if h == w || strings.HasPrefix(h, w+"/") {
				return true
			}
		}
	}
	return false
}

func underAny(p string, folders []string) bool {
	for _, f := range folders {
		f = strings.Trim(f, "/")
		if f == "" || strings.HasPrefix(p, f+"/") {
			return true
		}
	}
	return false
}
