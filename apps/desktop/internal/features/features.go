// Package features turns the `features` section of the distributed configuration into
// flags: a false value hides the function in the client (§2.6.6). The flags, their defaults and
// their descriptions come from api/config-profile.schema.json, generated into
// memobrain/shared/features by `task gen`; this package only adapts them to the client.
//
// The drawing_* flags refine "drawings": each hides one family of functions of the drawing
// editor (formulas, Mermaid diagrams, auto-export, the scene actions) and has no effect while
// "drawings" itself is off. web_workbench lets a user open vaults in the Web UI (ADR-0029): the
// desktop ignores it.
package features

import shared "memobrain/shared/features"

// Known lists the flags the client understands (the schema's, in schema order).
var Known = shared.Known

// Defaults are the flags of an unmanaged client: the schema's defaults (off for the functions
// not offered yet, such as the chat bar, ADR-0026, and for the ADR-0034 format switches).
var Defaults = shared.Defaults

// Flags resolves every known flag from the configuration.
func Flags(cfg map[string]any) map[string]bool { return shared.Flags(cfg) }

// Enabled reports one flag (a flag the schema does not know is on).
func Enabled(cfg map[string]any, name string) bool { return shared.Enabled(cfg, name) }
