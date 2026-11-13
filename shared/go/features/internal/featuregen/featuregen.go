// Package featuregen reads the Config Profile schema (api/config-profile.schema.json) and renders
// the code generated from it: the Go flag constants and defaults of package features, and the
// TypeScript module of @clarae/api-client (`@clarae/api-client/features`). The schema is the
// only place where a flag, its default and its description are written (P8 of the W8 review).
package featuregen

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"go/format"
	"sort"
	"strconv"
	"strings"
)

// Flag is one property of the `features` section.
type Flag struct {
	Name        string // snake_case key, e.g. "web_workbench"
	Default     bool
	Description string
}

// Ident is the exported Go / TypeScript identifier of the flag ("web_workbench" -> "WebWorkbench").
func (f Flag) Ident() string { return camel(f.Name) }

// Key is a leaf of the schema as an administrator writes it in a profile ("editor.fontSize").
type Key struct {
	Path string
	// Type is "boolean", "integer", "number", "string", "enum", "object" or "array".
	Type string
	// Enum lists the allowed values of an enum.
	Enum []string
	// Default is the product default (the schema's "default" keyword), nil when there is none.
	Default any
}

// Schema is what the generator needs from the JSON Schema.
type Schema struct {
	Flags []Flag
	Keys  []Key
	// Sections are the top-level keys a profile may have, in schema order.
	Sections []string
	// Defaults are the product defaults: every "default" keyword, nested by section.
	Defaults map[string]map[string]any
	// sections keeps the order of the sections that have defaults.
	sections []string
}

// node is a JSON object that remembers the order of its keys.
type node struct {
	keys []string
	vals map[string]json.RawMessage
}

func (n *node) UnmarshalJSON(b []byte) error {
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	t, err := dec.Token()
	if err != nil {
		return err
	}
	if d, ok := t.(json.Delim); !ok || d != '{' {
		return errors.New("not an object")
	}
	n.vals = map[string]json.RawMessage{}
	for dec.More() {
		t, err := dec.Token()
		if err != nil {
			return err
		}
		k, _ := t.(string)
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return err
		}
		n.keys = append(n.keys, k)
		n.vals[k] = raw
	}
	return nil
}

func (n *node) object(key string) (*node, error) {
	raw, ok := n.vals[key]
	if !ok {
		return nil, nil
	}
	var out node
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("%s: %w", key, err)
	}
	return &out, nil
}

func (n *node) str(key string) string {
	var s string
	_ = json.Unmarshal(n.vals[key], &s)
	return s
}

// value decodes a JSON value keeping integers as int.
func value(raw json.RawMessage) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	if num, ok := v.(json.Number); ok {
		if i, err := num.Int64(); err == nil {
			return int(i), nil
		}
		return num.Float64()
	}
	return v, nil
}

// Parse reads the schema.
func Parse(raw []byte) (*Schema, error) {
	var root node
	if err := json.Unmarshal(raw, &root); err != nil {
		return nil, err
	}
	props, err := root.object("properties")
	if err != nil || props == nil {
		return nil, fmt.Errorf("schema without properties: %v", err)
	}
	s := &Schema{Defaults: map[string]map[string]any{}}
	for _, section := range props.keys {
		s.Sections = append(s.Sections, section)
		sec, err := props.object(section)
		if err != nil {
			return nil, err
		}
		if err := s.walk(section, sec); err != nil {
			return nil, err
		}
	}
	return s, nil
}

func (s *Schema) walk(section string, sec *node) error {
	sub, err := sec.object("properties")
	if err != nil {
		return err
	}
	if sub == nil { // a section set as a whole: hotkeys (a map), servers (an array)
		s.Keys = append(s.Keys, Key{Path: section, Type: sec.str("type")})
		return nil
	}
	for _, name := range sub.keys {
		p, err := sub.object(name)
		if err != nil {
			return err
		}
		k := Key{Path: section + "." + name, Type: p.str("type")}
		if raw, ok := p.vals["enum"]; ok {
			k.Type = "enum"
			if err := json.Unmarshal(raw, &k.Enum); err != nil {
				return fmt.Errorf("%s: enum: %w", k.Path, err)
			}
		}
		if raw, ok := p.vals["default"]; ok {
			if k.Default, err = value(raw); err != nil {
				return fmt.Errorf("%s: default: %w", k.Path, err)
			}
			if _, seen := s.Defaults[section]; !seen {
				s.Defaults[section] = map[string]any{}
				s.sections = append(s.sections, section)
			}
			s.Defaults[section][name] = k.Default
		}
		if section == "features" {
			def, ok := k.Default.(bool)
			if k.Type != "boolean" || !ok {
				return fmt.Errorf("%s: a feature flag is a boolean with a boolean default", k.Path)
			}
			desc := p.str("description")
			if desc == "" {
				return fmt.Errorf("%s: a feature flag needs a description", k.Path)
			}
			s.Flags = append(s.Flags, Flag{Name: name, Default: def, Description: desc})
		}
		s.Keys = append(s.Keys, k)
	}
	return nil
}

func camel(snake string) string {
	var b strings.Builder
	for _, part := range strings.Split(snake, "_") {
		if part == "" {
			continue
		}
		b.WriteString(strings.ToUpper(part[:1]) + part[1:])
	}
	return b.String()
}

// Header is the first line of every generated file.
const Header = "Code generated by `task gen` (go run ./features/gen in shared/go) from api/config-profile.schema.json. DO NOT EDIT."

// wrap breaks a description into comment lines of about 100 columns.
func wrap(text, prefix string) string {
	var out, line strings.Builder
	for _, w := range strings.Fields(text) {
		if line.Len() > 0 && line.Len()+len(w)+1 > 96 {
			out.WriteString(prefix + line.String() + "\n")
			line.Reset()
		}
		if line.Len() > 0 {
			line.WriteByte(' ')
		}
		line.WriteString(w)
	}
	if line.Len() > 0 {
		out.WriteString(prefix + line.String() + "\n")
	}
	return out.String()
}

func goValue(v any) string {
	switch t := v.(type) {
	case string:
		return strconv.Quote(t)
	case bool:
		return strconv.FormatBool(t)
	case int:
		return strconv.Itoa(t)
	case float64:
		return strconv.FormatFloat(t, 'g', -1, 64)
	}
	return fmt.Sprintf("%#v", v)
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// Go renders shared/go/features/features_gen.go.
func Go(s *Schema) ([]byte, error) {
	var b strings.Builder
	b.WriteString("// " + Header + "\n\npackage features\n\n")
	b.WriteString("// Flag names: the keys of the `features` section of the Config Profile.\nconst (\n")
	for i, f := range s.Flags {
		if i > 0 {
			b.WriteByte('\n')
		}
		b.WriteString(wrap(f.Ident()+": "+f.Description, "\t// "))
		fmt.Fprintf(&b, "\t%s = %q\n", f.Ident(), f.Name)
	}
	b.WriteString(")\n\n// Known lists every flag of the schema, in schema order.\nvar Known = []string{\n")
	for _, f := range s.Flags {
		fmt.Fprintf(&b, "\t%s,\n", f.Ident())
	}
	b.WriteString("}\n\n// Defaults is the value of each flag when no profile sets it.\nvar Defaults = map[string]bool{\n")
	for _, f := range s.Flags {
		fmt.Fprintf(&b, "\t%s: %t,\n", f.Ident(), f.Default)
	}
	b.WriteString("}\n\n// Descriptions documents each flag (the schema's description).\nvar Descriptions = map[string]string{\n")
	for _, f := range s.Flags {
		fmt.Fprintf(&b, "\t%s: %q,\n", f.Ident(), f.Description)
	}
	b.WriteString("}\n\n// productDefaults builds the product defaults: every \"default\" keyword of the schema.\nfunc productDefaults() map[string]any {\n\treturn map[string]any{\n")
	sections := append([]string(nil), s.sections...)
	sort.Strings(sections)
	for _, sec := range sections {
		fmt.Fprintf(&b, "\t\t%q: map[string]any{\n", sec)
		for _, k := range sortedKeys(s.Defaults[sec]) {
			fmt.Fprintf(&b, "\t\t\t%q: %s,\n", k, goValue(s.Defaults[sec][k]))
		}
		b.WriteString("\t\t},\n")
	}
	b.WriteString("\t}\n}\n")
	return format.Source([]byte(b.String()))
}

// TS renders packages/api-client/src/gen/features.ts.
func TS(s *Schema) []byte {
	var b strings.Builder
	b.WriteString("// " + Header + "\n\n")
	b.WriteString("/** Flag names: the keys of the `features` section of the Config Profile. */\nexport const Feature = {\n")
	for _, f := range s.Flags {
		b.WriteString(wrap(f.Description, "  // "))
		fmt.Fprintf(&b, "  %s: '%s',\n", f.Ident(), f.Name)
	}
	b.WriteString("} as const;\n\n/** A flag of the schema. */\nexport type Feature = (typeof Feature)[keyof typeof Feature];\n\n")
	b.WriteString("/** Every flag of the schema, in schema order. */\nexport const FEATURES: readonly Feature[] = [\n")
	for _, f := range s.Flags {
		fmt.Fprintf(&b, "  Feature.%s,\n", f.Ident())
	}
	b.WriteString("];\n\n/** The value of each flag when no profile sets it. */\nexport const FEATURE_DEFAULTS: Readonly<Record<Feature, boolean>> = {\n")
	for _, f := range s.Flags {
		fmt.Fprintf(&b, "  [Feature.%s]: %t,\n", f.Ident(), f.Default)
	}
	b.WriteString("};\n\n/** The sections of a Config Profile: the top-level keys the schema allows, in schema order. */\nexport const CONFIG_SECTIONS: readonly string[] = [\n")
	for _, section := range s.Sections {
		fmt.Fprintf(&b, "  '%s',\n", section)
	}
	b.WriteString("];\n")
	return []byte(b.String())
}

// SchemaPath is the schema, relative to the repository root.
const SchemaPath = "api/config-profile.schema.json"

// File is a generated file, with its path relative to the repository root.
type File struct {
	Path    string
	Content []byte
}

// Files renders every generated file from the schema.
func Files(raw []byte) ([]File, error) {
	s, err := Parse(raw)
	if err != nil {
		return nil, err
	}
	goSrc, err := Go(s)
	if err != nil {
		return nil, err
	}
	return []File{
		{Path: "shared/go/features/features_gen.go", Content: goSrc},
		{Path: "shared/go/features/config-profile.schema.json", Content: raw},
		{Path: "packages/api-client/src/gen/features.ts", Content: TS(s)},
	}, nil
}
