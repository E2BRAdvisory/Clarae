// Package features turns the `features` section of the distributed configuration into
// flags: a false value hides the function in the client (§2.6.6). A flag the
// configuration does not mention is on, so a new function is available until an
// administrator switches it off.
package features

// Known lists the flags the client understands.
//
// The drawing_* flags refine "drawings": each hides one family of functions of the drawing
// editor (formulas, Mermaid diagrams, auto-export, the scene actions) and has no effect while
// "drawings" itself is off.
var Known = []string{
	"audio_recorder", "web_viewer", "chat", "web_workbench", "drawings", "canvas", "sharing",
	"drawing_latex", "drawing_mermaid", "drawing_auto_export", "drawing_actions",
}

// Defaults are the flags of an unmanaged client: everything the product ships is on,
// except what is off by default in the product defaults (audio recorder, web viewer, chat: the
// chat bar is a disabled placeholder until the ACP integration exists, ADR-0026).
var Defaults = map[string]bool{
	"audio_recorder": false,
	"web_viewer":     false,
	"chat":           false,
	// web_workbench lets a user open vaults in the Web UI (ADR-0029). The desktop ignores it.
	"web_workbench": true,
	"drawings":      true,
	"canvas":        true,
	"sharing":       true,

	"drawing_latex":       true,
	"drawing_mermaid":     true,
	"drawing_auto_export": true,
	"drawing_actions":     true,
}

// Flags resolves every known flag from the configuration.
func Flags(cfg map[string]any) map[string]bool {
	out := make(map[string]bool, len(Known))
	section, _ := cfg["features"].(map[string]any)
	for _, k := range Known {
		out[k] = Defaults[k]
		if v, ok := section[k].(bool); ok {
			out[k] = v
		}
	}
	return out
}

// Enabled reports one flag.
func Enabled(cfg map[string]any, name string) bool {
	if v, ok := Flags(cfg)[name]; ok {
		return v
	}
	return true
}
