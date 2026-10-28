//go:build integration

package sync_test

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"testing"
)

// M3-WP4: drawings and canvases of the same user merge per element/node id, so two devices
// that edit different parts of one file both keep their work.

type obj = map[string]any

func mustJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err) // the builders below marshal static, well-formed data
	}
	return string(b)
}

func parse(t *testing.T, s string) obj {
	t.Helper()
	var o obj
	if err := json.Unmarshal([]byte(s), &o); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, s)
	}
	return o
}

func el(id string, version, x int) obj {
	return obj{"id": id, "type": "rectangle", "x": x, "y": 0, "width": 50, "height": 50,
		"version": version, "versionNonce": version * 7, "isDeleted": false}
}

func drawing(elements ...obj) string {
	return mustJSON(obj{"type": "excalidraw", "version": 2, "elements": elements, "appState": obj{}, "files": obj{}})
}

// elementsOf returns id -> version of a drawing's elements.
func elementsOf(t *testing.T, s string) map[string]int {
	t.Helper()
	out := map[string]int{}
	for _, raw := range parse(t, s)["elements"].([]any) {
		e := raw.(obj)
		out[e["id"].(string)] = int(e["version"].(float64))
	}
	return out
}

func TestExcalidrawEditsInDifferentPartsConverge(t *testing.T) {
	v := createVault(t, "ada", "drawings")
	a := newDevice(t, "ada", "laptop", v, nil)
	b := newDevice(t, "ada", "desktop", v, nil)
	a.write("Sketch.excalidraw", drawing(el("e1", 1, 0), el("e2", 1, 100), el("e3", 1, 200)))
	a.sync()
	b.sync()

	// A moves e1; B moves e3 and adds e4.
	a.write("Sketch.excalidraw", drawing(el("e1", 2, 10), el("e2", 1, 100), el("e3", 1, 200)))
	b.write("Sketch.excalidraw", drawing(el("e1", 1, 0), el("e2", 1, 100), el("e3", 2, 210), el("e4", 1, 300)))
	a.sync()
	b.sync() // pulls A's version, merges by id, pushes the result
	a.sync()

	want := map[string]int{"e1": 2, "e2": 1, "e3": 2, "e4": 1}
	for _, d := range []*device{a, b} {
		got := elementsOf(t, d.read("Sketch.excalidraw"))
		if fmt.Sprint(got) != fmt.Sprint(want) {
			t.Errorf("%s: elements %v, want %v", d.name, got, want)
		}
		if len(d.files()) != 1 {
			t.Errorf("%s: a clean per-id merge must not create copies: %v", d.name, sortedKeys(d.files()))
		}
	}
	if len(a.conflicts)+len(b.conflicts) != 0 {
		t.Error("no conflict expected")
	}
}

func TestExcalidrawSameElementHigherVersionWins(t *testing.T) {
	v := createVault(t, "ada", "drawings-same")
	a := newDevice(t, "ada", "laptop", v, nil)
	b := newDevice(t, "ada", "desktop", v, nil)
	a.write("Sketch.excalidraw", drawing(el("e1", 1, 0), el("e2", 1, 100)))
	a.sync()
	b.sync()

	a.write("Sketch.excalidraw", drawing(el("e1", 2, 20), el("e2", 1, 100)))
	b.write("Sketch.excalidraw", drawing(el("e1", 4, 40), el("e2", 1, 100)))
	a.sync()
	b.sync()
	a.sync()
	for _, d := range []*device{a, b} {
		if got := elementsOf(t, d.read("Sketch.excalidraw")); got["e1"] != 4 {
			t.Errorf("%s: e1 at version %d, want the higher one (4)", d.name, got["e1"])
		}
	}
}

func TestExcalidrawDeletionStaysDeleted(t *testing.T) {
	v := createVault(t, "ada", "drawings-del")
	a := newDevice(t, "ada", "laptop", v, nil)
	b := newDevice(t, "ada", "desktop", v, nil)
	a.write("Sketch.excalidraw", drawing(el("e1", 1, 0), el("e2", 1, 100)))
	a.sync()
	b.sync()

	deleted := el("e1", 2, 0)
	deleted["isDeleted"] = true
	a.write("Sketch.excalidraw", drawing(deleted, el("e2", 1, 100)))
	b.write("Sketch.excalidraw", drawing(el("e1", 1, 0), el("e2", 2, 120)))
	a.sync()
	b.sync()
	a.sync()
	for _, d := range []*device{a, b} {
		doc := parse(t, d.read("Sketch.excalidraw"))
		for _, raw := range doc["elements"].([]any) {
			e := raw.(obj)
			if e["id"] == "e1" && e["isDeleted"] != true {
				t.Errorf("%s: the deleted element came back", d.name)
			}
			if e["id"] == "e2" && e["version"].(float64) != 2 {
				t.Errorf("%s: B's edit of e2 was lost", d.name)
			}
		}
	}
}

// ADR-0024: frames, images with customData, the per-drawing `memobrain` key, the derived
// exports next to the drawing and the vault's drawing settings travel and merge like the rest.
func TestExcalidrawExtraElementsAndDerivedFilesConverge(t *testing.T) {
	v := createVault(t, "ada", "drawings-extra")
	a := newDevice(t, "ada", "laptop", v, nil)
	b := newDevice(t, "ada", "desktop", v, nil)

	frame := func(version int, name string) obj {
		return obj{"id": "f1", "type": "frame", "name": name, "x": 0, "y": 0, "width": 400, "height": 300,
			"version": version, "versionNonce": version * 7, "isDeleted": false}
	}
	formula := func(version int, tex string) obj {
		return obj{"id": "m1", "type": "image", "fileId": "F1", "x": 10, "y": 10, "width": 40, "height": 20,
			"customData": obj{"memobrain": obj{"kind": "latex", "latex": tex}},
			"version":    version, "versionNonce": version * 7, "isDeleted": false}
	}
	withKey := func(base string, key obj) string {
		d := parse(t, base)
		d["memobrain"] = key
		return mustJSON(d)
	}

	a.write("Board.excalidraw", drawing(frame(1, "Slide 1"), formula(1, "a")))
	a.write(".memobrain/drawing.json", `{"autoExport":"none"}`)
	a.sync()
	b.sync()

	// A edits the formula and turns on auto-export for this drawing (and writes the PNG);
	// B renames the frame and adds a shape inside it.
	a.write("Board.excalidraw", withKey(drawing(frame(1, "Slide 1"), formula(2, "b")), obj{"autoExport": "png"}))
	a.writeBytes("Board.excalidraw.png", []byte("\x89PNG fake"))
	inside := el("r1", 1, 20)
	inside["frameId"] = "f1"
	b.write("Board.excalidraw", drawing(frame(2, "Intro"), formula(1, "a"), inside))
	a.sync()
	b.sync()
	a.sync()

	for _, d := range []*device{a, b} {
		doc := d.read("Board.excalidraw")
		parsed := parse(t, doc)
		byID := map[string]obj{}
		for _, raw := range parsed["elements"].([]any) {
			e := raw.(obj)
			byID[e["id"].(string)] = e
		}
		if len(byID) != 3 || byID["f1"]["name"] != "Intro" || byID["r1"]["frameId"] != "f1" {
			t.Errorf("%s: frame and its shape not merged: %v", d.name, byID)
		}
		latex := byID["m1"]["customData"].(obj)["memobrain"].(obj)["latex"]
		if latex != "b" {
			t.Errorf("%s: formula source %v, want A's edit (b)", d.name, latex)
		}
		if key, _ := parsed["memobrain"].(obj); key["autoExport"] != "png" {
			t.Errorf("%s: the per-drawing setting was lost: %v", d.name, parsed["memobrain"])
		}
		if !d.exists("Board.excalidraw.png") || d.read(".memobrain/drawing.json") != `{"autoExport":"none"}` {
			t.Errorf("%s: derived export or drawing settings missing: %v", d.name, sortedKeys(d.files()))
		}
	}
	if len(a.conflicts)+len(b.conflicts) != 0 {
		t.Error("no conflict expected")
	}
}

func node(id string, x int, text string) obj {
	return obj{"id": id, "type": "text", "x": x, "y": 0, "width": 200, "height": 80, "text": text}
}

func canvas(nodes []obj, edges ...obj) string {
	if edges == nil {
		edges = []obj{}
	}
	return mustJSON(obj{"nodes": nodes, "edges": edges})
}

func idsOf(t *testing.T, s, key string) []string {
	t.Helper()
	var out []string
	for _, raw := range parse(t, s)[key].([]any) {
		out = append(out, raw.(obj)["id"].(string))
	}
	sort.Strings(out)
	return out
}

func TestCanvasEditsInDifferentNodesConverge(t *testing.T) {
	v := createVault(t, "ada", "canvas")
	a := newDevice(t, "ada", "laptop", v, nil)
	b := newDevice(t, "ada", "desktop", v, nil)
	a.write("Map.canvas", canvas([]obj{node("n1", 0, "one"), node("n2", 300, "two")}))
	a.sync()
	b.sync()

	// A adds a node; B edits n2 and connects n1 to n2.
	a.write("Map.canvas", canvas([]obj{node("n1", 0, "one"), node("n2", 300, "two"), node("n3", 600, "three")}))
	b.write("Map.canvas", canvas([]obj{node("n1", 0, "one"), node("n2", 300, "two (edited on B)")},
		obj{"id": "e1", "fromNode": "n1", "toNode": "n2"}))
	a.sync()
	b.sync()
	a.sync()

	for _, d := range []*device{a, b} {
		doc := d.read("Map.canvas")
		if got := fmt.Sprint(idsOf(t, doc, "nodes")); got != "[n1 n2 n3]" {
			t.Errorf("%s: nodes %s", d.name, got)
		}
		if got := fmt.Sprint(idsOf(t, doc, "edges")); got != "[e1]" {
			t.Errorf("%s: edges %s", d.name, got)
		}
		if !strings.Contains(doc, "two (edited on B)") {
			t.Errorf("%s: B's edit was lost", d.name)
		}
	}
}

func TestCanvasSameNodeEditedOnBothKeepsBothVersions(t *testing.T) {
	v := createVault(t, "ada", "canvas-conflict")
	a := newDevice(t, "ada", "laptop", v, nil)
	b := newDevice(t, "ada", "desktop", v, nil)
	a.write("Map.canvas", canvas([]obj{node("n1", 0, "one")}))
	a.sync()
	b.sync()

	a.write("Map.canvas", canvas([]obj{node("n1", 0, "one by A")}))
	b.write("Map.canvas", canvas([]obj{node("n1", 0, "one by B")}))
	a.sync()
	b.sync()
	a.sync()

	// Nothing is lost silently: one version stays at the path, the other becomes a copy.
	var texts []string
	for p, c := range b.files() {
		if strings.HasSuffix(p, ".canvas") {
			texts = append(texts, c)
		}
	}
	joined := strings.Join(texts, "\n")
	if !strings.Contains(joined, "one by A") || !strings.Contains(joined, "one by B") {
		t.Fatalf("a version was lost: %v", sortedKeys(b.files()))
	}
	if fmt.Sprint(sortedKeys(a.files())) != fmt.Sprint(sortedKeys(b.files())) {
		t.Errorf("devices diverge: A %v B %v", sortedKeys(a.files()), sortedKeys(b.files()))
	}
}
