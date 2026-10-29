package features

import "testing"

func TestFlags(t *testing.T) {
	// Unmanaged: the product defaults.
	f := Flags(nil)
	if f["drawings"] != true || f["canvas"] != true || f["sharing"] != true || f["audio_recorder"] != false || f["web_viewer"] != false {
		t.Fatalf("defaults: %v", f)
	}
	// The configuration can switch things on and off; unknown keys are ignored.
	cfg := map[string]any{"features": map[string]any{"drawings": false, "audio_recorder": true, "mystery": true, "canvas": "no"}}
	f = Flags(cfg)
	if f["drawings"] || !f["audio_recorder"] || !f["canvas"] || len(f) != len(Known) {
		t.Fatalf("configured: %v", f)
	}
	if Enabled(cfg, "drawings") || !Enabled(cfg, "audio_recorder") || !Enabled(cfg, "unheard-of") {
		t.Error("Enabled")
	}
}

func TestDrawingSubFlags(t *testing.T) {
	f := Flags(nil)
	for _, k := range []string{"drawing_latex", "drawing_mermaid", "drawing_auto_export", "drawing_actions"} {
		if !f[k] {
			t.Errorf("%s must be on by default", k)
		}
	}
	cfg := map[string]any{"features": map[string]any{"drawing_latex": false, "drawing_mermaid": false}}
	if Enabled(cfg, "drawing_latex") || Enabled(cfg, "drawing_mermaid") || !Enabled(cfg, "drawing_actions") || !Enabled(cfg, "drawings") {
		t.Error("a sub-flag switches off only its own function")
	}
}

// web_workbench is the administrator's switch for opening vaults in the Web UI: on unless turned off.
func TestWebWorkbenchFlag(t *testing.T) {
	if !Flags(nil)["web_workbench"] || !Enabled(nil, "web_workbench") {
		t.Fatal("the web workbench must be on by default")
	}
	off := map[string]any{"features": map[string]any{"web_workbench": false}}
	if Flags(off)["web_workbench"] || Enabled(off, "web_workbench") {
		t.Fatal("the configuration must be able to turn it off")
	}
}
