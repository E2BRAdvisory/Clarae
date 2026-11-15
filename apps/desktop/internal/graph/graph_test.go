package graph_test

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"clarae/apps/desktop/internal/graph"
	"clarae/apps/desktop/internal/indexer"
	"clarae/apps/desktop/internal/store"
	"clarae/apps/desktop/internal/vault"
)

func indexVault(t testing.TB, files map[string]string) *sql.DB {
	t.Helper()
	ctx := context.Background()
	root := t.TempDir()
	fsys, err := vault.NewFS(root)
	if err != nil {
		t.Fatal(err)
	}
	for p, c := range files {
		if _, err := fsys.WriteFile(p, []byte(c), "", false); err != nil {
			t.Fatal(err)
		}
	}
	db, err := store.Open(ctx, filepath.Join(root, ".clarae", "index.db"), store.KindIndex)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := indexer.New(fsys, db, zerolog.Nop(), nil).Full(ctx); err != nil {
		t.Fatal(err)
	}
	return db
}

func ids(g graph.Graph) map[string]graph.Node {
	m := map[string]graph.Node{}
	for _, n := range g.Nodes {
		m[n.ID] = n
	}
	return m
}

func sample(t testing.TB) *sql.DB {
	return indexVault(t, map[string]string{
		"a.md":         "---\ncreated: 2024-01-05\ntags: [proj]\n---\n# A\n[[b]] [[Missing note]] ![[pic.png]]\n",
		"b.md":         "[[c]] #proj/x\n",
		"c.md":         "[[a]]\n",
		"d.md":         "[[c]]\n",
		"lonely.md":    "nothing here\n",
		"sub/e.md":     "[[d]]\n",
		"pic.png":      "x",
		"sub/other.md": "plain",
	})
}

func TestBuildBasics(t *testing.T) {
	db := sample(t)
	g, err := graph.Build(context.Background(), db, graph.Options{})
	if err != nil {
		t.Fatal(err)
	}
	m := ids(g)
	for _, want := range []string{"a.md", "b.md", "c.md", "d.md", "sub/e.md"} {
		if _, ok := m[want]; !ok {
			t.Errorf("missing node %s", want)
		}
	}
	for _, no := range []string{"lonely.md", "sub/other.md", "pic.png", "ghost:missing note", "tag:proj"} {
		if _, ok := m[no]; ok {
			t.Errorf("unexpected node %s", no)
		}
	}
	if m["c.md"].Degree != 3 { // b->c, c->a, d->c
		t.Errorf("degree c = %d", m["c.md"].Degree)
	}
	if m["a.md"].Created == 0 || time.UnixMilli(m["a.md"].Created).Year() != 2024 {
		t.Errorf("created from frontmatter: %d", m["a.md"].Created)
	}
	if m["b.md"].Created == 0 {
		t.Error("created should fall back to mtime")
	}
}

func TestBuildToggles(t *testing.T) {
	db := sample(t)
	g, err := graph.Build(context.Background(), db, graph.Options{ShowOrphans: true, ShowGhosts: true, ShowAttachments: true, ShowTags: true})
	if err != nil {
		t.Fatal(err)
	}
	m := ids(g)
	for _, want := range []string{"lonely.md", "ghost:missing note", "pic.png", "tag:proj", "tag:proj/x"} {
		if _, ok := m[want]; !ok {
			t.Errorf("missing node %s", want)
		}
	}
	if m["ghost:missing note"].Kind != graph.KindGhost || m["ghost:missing note"].Label != "Missing note" {
		t.Errorf("ghost: %+v", m["ghost:missing note"])
	}
	if len(g.Nodes) == 0 || g.Truncated {
		t.Error("unexpected truncation")
	}
}

func TestBuildFilters(t *testing.T) {
	db := sample(t)
	ctx := context.Background()
	g, _ := graph.Build(ctx, db, graph.Options{Folders: []string{"sub"}, ShowOrphans: true})
	if m := ids(g); len(m) != 2 || m["sub/e.md"].Path == "" {
		t.Errorf("folders: %v", m)
	}
	g, _ = graph.Build(ctx, db, graph.Options{ExcludeFolders: []string{"sub"}})
	if _, ok := ids(g)["sub/e.md"]; ok {
		t.Error("excluded folder present")
	}
	g, _ = graph.Build(ctx, db, graph.Options{Tags: []string{"#proj"}})
	if m := ids(g); len(m) != 2 || m["a.md"].Path == "" || m["b.md"].Path == "" {
		t.Errorf("tags: %v", m)
	}
	g, err := graph.Build(ctx, db, graph.Options{Query: "file:a OR file:b"})
	if err != nil {
		t.Fatal(err)
	}
	if m := ids(g); len(m) != 2 {
		t.Errorf("query: %v", m)
	}
	if _, err := graph.Build(ctx, db, graph.Options{Query: "(unclosed"}); err == nil {
		t.Error("expected a query error")
	}
}

func TestLocalGraph(t *testing.T) {
	db := sample(t)
	ctx := context.Background()
	cases := []struct {
		dir   string
		depth int
		want  []string
	}{
		{"out", 1, []string{"c.md"}},
		{"in", 1, []string{"sub/e.md"}},
		{"both", 1, []string{"c.md", "sub/e.md"}},
		{"out", 2, []string{"c.md", "a.md"}},
		{"both", 3, []string{"c.md", "sub/e.md", "a.md", "b.md"}},
	}
	for _, c := range cases {
		g, err := graph.Build(ctx, db, graph.Options{Center: "d.md", Depth: c.depth, Direction: c.dir})
		if err != nil {
			t.Fatal(err)
		}
		m := ids(g)
		if len(m) != len(c.want)+1 {
			t.Errorf("%s/%d: got %d nodes: %v", c.dir, c.depth, len(m), m)
		}
		for _, w := range c.want {
			if _, ok := m[w]; !ok {
				t.Errorf("%s/%d: missing %s", c.dir, c.depth, w)
			}
		}
	}
	g, _ := graph.Build(ctx, db, graph.Options{Center: "unknown.md"})
	if len(g.Nodes) != 0 {
		t.Error("unknown centre should give an empty graph")
	}
	g, _ = graph.Build(ctx, db, graph.Options{Center: "lonely.md", Depth: 1})
	if len(g.Nodes) != 1 {
		t.Errorf("centre without links stays visible: %d", len(g.Nodes))
	}
}

func TestGroupsAndTruncation(t *testing.T) {
	db := sample(t)
	ctx := context.Background()
	g, err := graph.Build(ctx, db, graph.Options{Groups: []string{"tag:proj", "", "file:c"}})
	if err != nil {
		t.Fatal(err)
	}
	m := ids(g)
	if gs := m["a.md"].Groups; len(gs) != 1 || gs[0] != 0 {
		t.Errorf("a groups %v", gs)
	}
	if gs := m["c.md"].Groups; len(gs) != 1 || gs[0] != 2 {
		t.Errorf("c groups %v", gs)
	}
	g, _ = graph.Build(ctx, db, graph.Options{MaxNodes: 2})
	if !g.Truncated || len(g.Nodes) != 2 || g.Total != 5 {
		t.Errorf("truncation: %d nodes, total %d, truncated %v", len(g.Nodes), g.Total, g.Truncated)
	}
	for _, e := range g.Edges {
		if e.Source >= 2 || e.Target >= 2 {
			t.Error("edge outside truncated node set")
		}
	}
}

// BenchmarkBuild10k builds a synthetic vault (default 10000 notes, ~5 links
// each, tags, some ghosts) and measures Build with everything enabled:
//
//	CLARAE_BENCH_NOTES=10000 go test -run xxx -bench Build -benchtime 3x ./internal/graph/
func BenchmarkBuild10k(b *testing.B) {
	n := 10000
	if v := os.Getenv("CLARAE_BENCH_NOTES"); v != "" {
		n, _ = strconv.Atoi(v)
	}
	files := make(map[string]string, n)
	for i := 0; i < n; i++ {
		var sb strings.Builder
		fmt.Fprintf(&sb, "---\ncreated: 2023-%02d-%02d\ntags: [t%d]\n---\n# Note %d\n", i%12+1, i%28+1, i%40, i)
		for l := 0; l < 5; l++ {
			fmt.Fprintf(&sb, "[[note%d]] ", (i*31+l*977)%n)
		}
		if i%10 == 0 {
			fmt.Fprintf(&sb, "[[ghost%d]]", i%200)
		}
		files[fmt.Sprintf("f%d/note%d.md", i%40, i)] = sb.String()
	}
	db := indexVault(b, files)
	opts := graph.Options{ShowOrphans: true, ShowGhosts: true, ShowTags: true, MaxNodes: 1 << 30}
	b.ResetTimer()
	var g graph.Graph
	for i := 0; i < b.N; i++ {
		var err error
		if g, err = graph.Build(context.Background(), db, opts); err != nil {
			b.Fatal(err)
		}
	}
	b.ReportMetric(float64(len(g.Nodes)), "nodes")
	b.ReportMetric(float64(len(g.Edges)), "edges")
}

// TestBuildScales is a smoke check that a 1000-note vault builds well under a second.
func TestBuildScales(t *testing.T) {
	if testing.Short() {
		t.Skip("short")
	}
	const n = 1000
	files := make(map[string]string, n)
	for i := 0; i < n; i++ {
		files[fmt.Sprintf("n%d.md", i)] = fmt.Sprintf("[[n%d]] [[n%d]] #t%d", (i+1)%n, (i*7)%n, i%10)
	}
	db := indexVault(t, files)
	start := time.Now()
	g, err := graph.Build(context.Background(), db, graph.Options{ShowTags: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(g.Nodes) < n {
		t.Fatalf("nodes: %d", len(g.Nodes))
	}
	if d := time.Since(start); d > 3*time.Second {
		t.Errorf("Build took %s", d)
	}
}

// documentsVault holds one of each kind of document next to the notes.
func documentsVault(t testing.TB) *sql.DB {
	return indexVault(t, map[string]string{
		"Plan.md":    "# Plan\n![[Table.base]] [[Deck.marp]]\n",
		"Other.md":   "# Other\n",
		"Deck.marp":  "---\nmarp: true\n---\n# Slide\n",
		"pic.png":    "x",
		"Table.base": "views: []\n",
		"Sketch.excalidraw": `{"type":"excalidraw","elements":[
		  {"id":"r","type":"rectangle","link":"[[Plan]]"},
		  {"id":"t","type":"text","text":"see [[Other]] and [[Missing sketch target]]"}]}`,
		"Map.canvas": `{"nodes":[
		  {"id":"f","type":"file","x":0,"y":0,"width":10,"height":10,"file":"Plan.md"},
		  {"id":"s","type":"file","x":0,"y":0,"width":10,"height":10,"file":"Sketch.excalidraw"},
		  {"id":"t","type":"text","x":0,"y":0,"width":10,"height":10,"text":"link to [[Other]]"}],"edges":[]}`,
		"Alone.canvas": `{"nodes":[],"edges":[]}`,
	})
}

func hasEdge(g graph.Graph, from, to string) bool {
	for _, e := range g.Edges {
		if g.Nodes[e.Source].ID == from && g.Nodes[e.Target].ID == to {
			return true
		}
	}
	return false
}

func TestBuildDocuments(t *testing.T) {
	db := documentsVault(t)
	ctx := context.Background()
	build := func(o graph.Options) graph.Graph {
		t.Helper()
		g, err := graph.Build(ctx, db, o)
		if err != nil {
			t.Fatal(err)
		}
		return g
	}

	// Off by default: no document, no edge to one.
	g := build(graph.Options{ShowOrphans: true, ShowGhosts: true, ShowAttachments: true})
	for id, n := range ids(g) {
		switch n.Kind {
		case graph.KindDrawing, graph.KindCanvas, graph.KindBase:
			t.Errorf("document %s shown without ShowDocuments", id)
		}
	}
	if _, ok := ids(g)["ghost:missing sketch target"]; ok {
		t.Error("a drawing must not feed ghosts while it is hidden")
	}
	if hasEdge(g, "Plan.md", "Table.base") || hasEdge(g, "Plan.md", "Deck.marp") != true {
		t.Errorf("edges: %v", g.Edges)
	}

	g = build(graph.Options{ShowDocuments: true, ShowGhosts: true})
	m := ids(g)
	for id, kind := range map[string]string{
		"Sketch.excalidraw": graph.KindDrawing, "Map.canvas": graph.KindCanvas, "Table.base": graph.KindBase,
		"Deck.marp": graph.KindNote, "Plan.md": graph.KindNote, "ghost:missing sketch target": graph.KindGhost,
	} {
		if n, ok := m[id]; !ok || n.Kind != kind {
			t.Errorf("%s: %+v (want kind %s)", id, n, kind)
		}
	}
	if _, ok := m["Alone.canvas"]; ok {
		t.Error("an orphan canvas is hidden without ShowOrphans")
	}
	if _, ok := m["pic.png"]; ok {
		t.Error("attachments stay off")
	}
	for _, e := range [][2]string{
		{"Sketch.excalidraw", "Plan.md"},  // the link field of an element
		{"Sketch.excalidraw", "Other.md"}, // a link inside a text
		{"Sketch.excalidraw", "ghost:missing sketch target"},
		{"Map.canvas", "Plan.md"}, // a file node
		{"Map.canvas", "Sketch.excalidraw"},
		{"Map.canvas", "Other.md"}, // a link inside a text node
		{"Plan.md", "Table.base"},  // a base embedded by a note
		{"Plan.md", "Deck.marp"},
	} {
		if !hasEdge(g, e[0], e[1]) {
			t.Errorf("missing edge %s -> %s", e[0], e[1])
		}
	}
	for _, e := range g.Edges {
		if g.Nodes[e.Source].ID == "Table.base" {
			t.Errorf("a base is never a link source: %v", e)
		}
	}
	if d := m["Plan.md"].Degree; d != 4 { // sketch, map, base, deck
		t.Errorf("degree of Plan.md = %d", d)
	}
	if g = build(graph.Options{ShowDocuments: true, ShowOrphans: true}); ids(g)["Alone.canvas"].Kind != graph.KindCanvas {
		t.Error("ShowOrphans keeps the empty canvas")
	}

	// Local graph centred on a drawing, then on a canvas.
	g = build(graph.Options{ShowDocuments: true, Center: "Sketch.excalidraw", Depth: 1, Direction: graph.DirBoth})
	m = ids(g)
	for _, w := range []string{"Sketch.excalidraw", "Plan.md", "Other.md", "Map.canvas"} {
		if _, ok := m[w]; !ok {
			t.Errorf("local graph of the drawing misses %s: %v", w, m)
		}
	}
	if len(m) != 4 {
		t.Errorf("local graph of the drawing: %v", m)
	}
	g = build(graph.Options{ShowDocuments: true, Center: "Sketch.excalidraw", Depth: 1, Direction: graph.DirIn})
	if m = ids(g); len(m) != 2 || m["Map.canvas"].Kind != graph.KindCanvas {
		t.Errorf("incoming links of the drawing: %v", m)
	}
	g = build(graph.Options{ShowDocuments: true, Center: "Map.canvas", Depth: 1, Direction: graph.DirOut})
	if m = ids(g); len(m) != 4 { // the canvas, Plan, Sketch, Other
		t.Errorf("outgoing links of the canvas: %v", m)
	}
	g = build(graph.Options{ShowDocuments: true, Center: "Table.base", Depth: 1, Direction: graph.DirBoth})
	if m = ids(g); len(m) != 2 || !hasEdge(g, "Plan.md", "Table.base") {
		t.Errorf("local graph of the base: %v", m)
	}
	if g = build(graph.Options{Center: "Sketch.excalidraw"}); len(g.Nodes) != 0 {
		t.Errorf("a hidden document is not a valid centre: %v", g.Nodes)
	}

	// Attachments and documents switch independently.
	g = build(graph.Options{ShowAttachments: true, ShowOrphans: true})
	if m = ids(g); m["pic.png"].Kind != graph.KindAttachment || m["Table.base"].Path != "" {
		t.Errorf("attachments only: %v", m)
	}
	g = build(graph.Options{ShowAttachments: true, ShowDocuments: true, ShowOrphans: true})
	if m = ids(g); m["pic.png"].Kind != graph.KindAttachment || m["Table.base"].Kind != graph.KindBase {
		t.Errorf("both: %v", m)
	}

	// Filters reach the documents like any other file.
	g = build(graph.Options{ShowDocuments: true, Folders: []string{"nowhere"}, ShowOrphans: true})
	if len(g.Nodes) != 0 {
		t.Errorf("folder filter: %v", ids(g))
	}
	g = build(graph.Options{ShowDocuments: true, Query: "file:Sketch OR file:Plan"})
	if m = ids(g); len(m) != 2 || !hasEdge(g, "Sketch.excalidraw", "Plan.md") {
		t.Errorf("query filter: %v", m)
	}
	g = build(graph.Options{ShowDocuments: true, Groups: []string{"file:Map", "file:Table"}})
	if m = ids(g); len(m["Map.canvas"].Groups) != 1 || m["Map.canvas"].Groups[0] != 0 || len(m["Table.base"].Groups) != 1 || m["Table.base"].Groups[0] != 1 {
		t.Errorf("groups: %v", m)
	}
	g = build(graph.Options{ShowDocuments: true, MaxNodes: 3})
	if !g.Truncated || len(g.Nodes) != 3 {
		t.Errorf("truncation: %d nodes", len(g.Nodes))
	}
}
