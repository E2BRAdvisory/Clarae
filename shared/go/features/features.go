// Package features is the Go side of the Config Profile schema (api/config-profile.schema.json,
// §2.6.6), shared by the cloud service and the desktop core (and so by the web workbench, which
// runs the same core). The flag names, their defaults and the product defaults are generated
// from the schema by `task gen` (features_gen.go); the TypeScript twin is
// `@memobrain/api-client/features`. Add a flag to the schema, with a default and a description,
// and run `task gen`: nothing else lists flags by hand.
package features

import _ "embed" // the schema is part of the binaries that validate profiles

// SchemaJSON is a byte copy of api/config-profile.schema.json, written by `task gen` (a module
// cannot embed a file outside its own tree). The cloud validates profiles against it.
//
//go:embed config-profile.schema.json
var SchemaJSON []byte

// ProductDefaults returns the built-in configuration every client starts from: the defaults of
// the schema (every flag, plus the keys with a "default"). Each call returns a fresh map.
func ProductDefaults() map[string]any { return productDefaults() }

// Flags resolves every known flag from a configuration: the value it sets when it is a boolean,
// otherwise the default.
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

// Enabled reports one flag. A flag the schema does not know is on unless the configuration
// switches it off, so a function newer than this build stays available.
func Enabled(cfg map[string]any, name string) bool {
	section, _ := cfg["features"].(map[string]any)
	if v, ok := section[name].(bool); ok {
		return v
	}
	if d, ok := Defaults[name]; ok {
		return d
	}
	return true
}
