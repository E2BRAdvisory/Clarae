package features_test

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"clarae/shared/features"
	"clarae/shared/features/internal/featuregen"
)

const root = "../../.."

// The generated files are what `task gen` writes from the schema today.
func TestGeneratedFilesMatchTheSchema(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(root, featuregen.SchemaPath))
	if err != nil {
		t.Fatal(err)
	}
	files, err := featuregen.Files(raw)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		got, err := os.ReadFile(filepath.Join(root, f.Path))
		if err != nil {
			t.Fatalf("%s: %v (run `task gen`)", f.Path, err)
		}
		if !bytes.Equal(got, f.Content) {
			t.Errorf("%s is out of date with %s: run `task gen`", f.Path, featuregen.SchemaPath)
		}
	}
	if !bytes.Equal(features.SchemaJSON, raw) {
		t.Error("the embedded schema differs from api/config-profile.schema.json: run `task gen`")
	}
}

func TestEveryFlagHasADefault(t *testing.T) {
	if len(features.Known) != len(features.Defaults) || len(features.Known) != len(features.Descriptions) {
		t.Fatalf("Known %d, Defaults %d, Descriptions %d", len(features.Known), len(features.Defaults), len(features.Descriptions))
	}
	// The flags whose default is off: functions not offered yet. The format switches of ADR-0034
	// and ADR-0042 are on by default since release N+1.
	// ai and collab (ADR-0050) are functions not offered yet that the code already reads: a flag the
	// schema did not declare would be on, so both must stay declared and off.
	// config_dir_v2 (ADR-0052) moves the synchronized settings of linked vaults to the new configuration
	// folder: off until every device of a vault runs 2.x.
	off := []string{features.AudioRecorder, features.WebViewer, features.Chat, features.Ai, features.Collab, features.ConfigDirV2}
	for _, k := range features.Known {
		want := true
		for _, o := range off {
			if k == o {
				want = false
			}
		}
		if features.Defaults[k] != want {
			t.Errorf("default of %s = %t, want %t", k, features.Defaults[k], want)
		}
	}
}

func TestProductDefaults(t *testing.T) {
	d := features.ProductDefaults()
	f, _ := d["features"].(map[string]any)
	if len(f) != len(features.Known) || f[features.WebWorkbench] != true || f[features.Chat] != false {
		t.Fatalf("features defaults = %v", f)
	}
	sync, _ := d["sync"].(map[string]any)
	auth, _ := d["auth"].(map[string]any)
	if sync["interval_seconds"] != 30 || sync["max_file_size_bytes"] != 104857600 || auth["redirect_mode"] != "auto" {
		t.Fatalf("product defaults = %v", d)
	}
	// Each call is a fresh map: a caller may modify it.
	f[features.Chat] = true
	if features.ProductDefaults()["features"].(map[string]any)[features.Chat] != false {
		t.Fatal("ProductDefaults must return a fresh map")
	}
	// The defaults validate against the schema's own types (a quick check: they marshal).
	if _, err := json.Marshal(d); err != nil {
		t.Fatal(err)
	}
}

func TestFlags(t *testing.T) {
	if got := features.Flags(nil); !reflect.DeepEqual(got, features.Defaults) {
		t.Fatalf("Flags(nil) = %v", got)
	}
	cfg := map[string]any{"features": map[string]any{"drawings": false, "chat": true, "canvas": "no", "mystery": false}}
	f := features.Flags(cfg)
	if f[features.Drawings] || !f[features.Chat] || !f[features.Canvas] || len(f) != len(features.Known) {
		t.Fatalf("Flags = %v", f)
	}
	if features.Enabled(cfg, features.Drawings) || !features.Enabled(cfg, features.Chat) || !features.Enabled(nil, features.EnvelopeV2) || !features.Enabled(nil, features.PathV2) {
		t.Fatal("Enabled disagrees with the configuration or the defaults")
	}
	// An administrator can still turn the v2 formats off (ADR-0034, ADR-0042).
	off := map[string]any{"features": map[string]any{features.EnvelopeV2: false, features.PathV2: false}}
	if features.Enabled(off, features.EnvelopeV2) || features.Enabled(off, features.PathV2) {
		t.Fatal("an explicit false must turn a v2 format off")
	}
	if !features.Enabled(nil, "unheard_of") || features.Enabled(cfg, "mystery") {
		t.Fatal("an unknown flag is on unless the configuration switches it off")
	}
}

// An empty or absent profile leaves the reserved functions off, and only an explicit true turns the
// flag on (the build constant of ADR-0050 is the second gate).
func TestReservedFlagsAreOffWithoutAProfile(t *testing.T) {
	for _, name := range []string{features.Ai, features.Collab} {
		if features.Enabled(nil, name) || features.Enabled(map[string]any{}, name) ||
			features.Enabled(map[string]any{"features": map[string]any{}}, name) {
			t.Errorf("%s is on without a profile: a flag read by the code must be declared with default false", name)
		}
		if !features.Enabled(map[string]any{"features": map[string]any{name: true}}, name) {
			t.Errorf("%s: an explicit true must turn the flag on", name)
		}
	}
}
