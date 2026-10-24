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
