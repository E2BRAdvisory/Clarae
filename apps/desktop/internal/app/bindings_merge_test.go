package app

import (
	"encoding/json"
	"strings"
	"testing"

	"clarae/shared/merge"
)

func excalidrawDoc(t *testing.T, els []map[string]any, files map[string]any) string {
	t.Helper()
	doc := map[string]any{"type": "excalidraw", "version": 2, "elements": els}
	if files != nil {
		doc["files"] = files
	}
	b, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func el(id string, version int, deleted bool) map[string]any {
	return map[string]any{"id": id, "type": "rectangle", "version": version, "versionNonce": 1, "isDeleted": deleted}
}

func idsOf(t *testing.T, doc string) map[string]map[string]any {
	t.Helper()
	var d struct {
		Elements []map[string]any `json:"elements"`
	}
	if err := json.Unmarshal([]byte(doc), &d); err != nil {
		t.Fatalf("merged text is not valid JSON: %v\n%s", err, doc)
	}
	out := map[string]map[string]any{}
	for _, e := range d.Elements {
		out[e["id"].(string)] = e
	}
	return out
}

func TestMergeEditDrawing(t *testing.T) {
	a, info, _ := newTestApp(t)
	v := NewVaultAPI(a)

	base := excalidrawDoc(t, []map[string]any{el("a", 1, false), el("b", 1, false)}, map[string]any{"f1": map[string]any{"id": "f1"}})
	ours := excalidrawDoc(t, []map[string]any{el("a", 1, false), el("b", 1, false), el("o", 1, false)}, map[string]any{"f1": map[string]any{"id": "f1"}, "fo": map[string]any{"id": "fo"}})
	theirs := excalidrawDoc(t, []map[string]any{el("a", 1, false), el("b", 2, true), el("t", 1, false)}, map[string]any{"f1": map[string]any{"id": "f1"}, "ft": map[string]any{"id": "ft"}})

	r, err := v.MergeEdit(info.ID, "Board.excalidraw", base, ours, theirs)
	if err != nil {
		t.Fatal(err)
	}
	if !r.Clean || r.Strategy != string(merge.StrategyExcalidrawID) {
		t.Fatalf("result = %+v, want a clean excalidraw-by-id merge (the vault is not linked: one author)", r)
	}
	els := idsOf(t, r.Merged)
	for _, id := range []string{"a", "o", "t"} {
		if _, ok := els[id]; !ok {
			t.Errorf("element %q missing from %v", id, els)
		}
	}
	if b, ok := els["b"]; !ok || b["isDeleted"] != true {
		t.Errorf("the tombstone with the higher version must win, got %v", els["b"])
	}
	var d struct {
		Files map[string]json.RawMessage `json:"files"`
	}
	if err := json.Unmarshal([]byte(r.Merged), &d); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"f1", "fo", "ft"} {
		if _, ok := d.Files[k]; !ok {
			t.Errorf("file %q missing from the merged files %v", k, d.Files)
		}
	}
}

func TestMergeEditUnchangedSide(t *testing.T) {
	a, info, _ := newTestApp(t)
	v := NewVaultAPI(a)
	base := excalidrawDoc(t, []map[string]any{el("a", 1, false)}, nil)
	changed := excalidrawDoc(t, []map[string]any{el("a", 1, false), el("n", 1, false)}, nil)

	for name, c := range map[string][3]string{
		"ours == base":   {base, base, changed},
		"theirs == base": {base, changed, base},
	} {
		r, err := v.MergeEdit(info.ID, "Board.excalidraw", c[0], c[1], c[2])
		if err != nil || !r.Clean {
			t.Fatalf("%s: %+v, %v", name, r, err)
		}
		if _, ok := idsOf(t, r.Merged)["n"]; !ok {
			t.Errorf("%s: the added element was lost: %s", name, r.Merged)
		}
	}
}

func TestMergeEditUnparsableIsAConflictCopyNotAnError(t *testing.T) {
	a, info, _ := newTestApp(t)
	v := NewVaultAPI(a)
	good := excalidrawDoc(t, []map[string]any{el("a", 1, false)}, nil)
	r, err := v.MergeEdit(info.ID, "Board.excalidraw", good, "{not json", good)
	if err != nil {
		t.Fatalf("an unparsable text is not an error of the call: %v", err)
	}
	if r.Clean || r.Merged != "" || r.Strategy != string(merge.StrategyConflictCopy) {
		t.Fatalf("result = %+v, want a conflict-copy, not clean, no text", r)
	}
}

func TestMergeEditMarkdown(t *testing.T) {
	a, info, _ := newTestApp(t)
	v := NewVaultAPI(a)
	base := "one\ntwo\nthree\nfour\nfive\nsix\nseven\n"

	r, err := v.MergeEdit(info.ID, "Note.md", base, "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\n", "one\ntwo\nthree\nfour\nfive\nsix\nSEVEN\n")
	if err != nil || !r.Clean || r.Strategy != string(merge.StrategyMarkdown3Way) {
		t.Fatalf("clean case: %+v, %v", r, err)
	}
	if r.Merged != "ONE\ntwo\nthree\nfour\nfive\nsix\nSEVEN\n" {
		t.Fatalf("merged = %q", r.Merged)
	}

	r, err = v.MergeEdit(info.ID, "Note.md", base, "one\nOURS\nthree\nfour\nfive\nsix\nseven\n", "one\nTHEIRS\nthree\nfour\nfive\nsix\nseven\n")
	if err != nil {
		t.Fatal(err)
	}
	if r.Clean || r.Merged != "" || r.Strategy != string(merge.StrategyMarkdown3Way) {
		t.Fatalf("conflicting case: %+v, want not clean, no text", r)
	}
}

func TestMergeEditCanvas(t *testing.T) {
	a, info, _ := newTestApp(t)
	v := NewVaultAPI(a)
	canvas := func(nodes ...string) string {
		var ns []string
		for _, id := range nodes {
			ns = append(ns, `{"id":"`+id+`","type":"text","text":"`+id+`","x":0,"y":0,"width":10,"height":10}`)
		}
		return `{"nodes":[` + strings.Join(ns, ",") + `],"edges":[]}`
	}
	r, err := v.MergeEdit(info.ID, "Map.canvas", canvas("a"), canvas("a", "o"), canvas("a", "t"))
	if err != nil || !r.Clean || r.Strategy != string(merge.StrategyCanvasID) {
		t.Fatalf("%+v, %v", r, err)
	}
	if !strings.Contains(r.Merged, `"o"`) || !strings.Contains(r.Merged, `"t"`) {
		t.Fatalf("a node was lost: %s", r.Merged)
	}
}

func TestMergeEditKindWithoutMerge(t *testing.T) {
	a, info, _ := newTestApp(t)
	v := NewVaultAPI(a)
	r, err := v.MergeEdit(info.ID, "pics/photo.png", "a", "b", "c")
	if err != nil {
		t.Fatal(err)
	}
	if r.Clean || r.Merged != "" || r.Strategy != string(merge.StrategyLastWriteWins) {
		t.Fatalf("an attachment of one author is last-write-wins and is not merged here: %+v", r)
	}
}

func TestMergeEditRefusals(t *testing.T) {
	a, info, _ := newTestApp(t)
	v := NewVaultAPI(a)
	if _, err := v.MergeEdit("no-such-vault", "Note.md", "", "", ""); err == nil {
		t.Fatal("a vault that is not open must be an error")
	}
	for _, p := range []string{"../escape.md", "/etc/passwd"} {
		if _, err := v.MergeEdit(info.ID, p, "", "", ""); err == nil {
			t.Errorf("path %q accepted", p)
		}
	}
}
