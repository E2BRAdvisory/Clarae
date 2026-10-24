// Package features turns the `features` section of the distributed configuration into
// flags: a false value hides the function in the client (§2.6.6). A flag the
// configuration does not mention is on, so a new function is available until an
// administrator switches it off.
package features

// Known lists the flags the client understands.
var Known = []string{"audio_recorder", "web_viewer", "drawings", "canvas", "sharing"}

// Defaults are the flags of an unmanaged client: everything the product ships is on,
// except what is off by default in the product defaults (audio recorder, web viewer).
var Defaults = map[string]bool{
	"audio_recorder": false,
	"web_viewer":     false,
	"drawings":       true,
	"canvas":         true,
	"sharing":        true,
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
