package bases

import (
	"fmt"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// SortSpec is one sort/groupBy criterion ("property" is as written: file.name, note.x, x, formula.f).
type SortSpec struct {
	Property  string `json:"property"`
	Direction string `json:"direction"` // ASC | DESC
}

// FilterNode is a node of a filter tree: and/or/not or a leaf expression.
type FilterNode struct {
	Op       string // and | or | not | expr
	Children []*FilterNode
	Src      string
	Expr     Expr
	Err      string // the node cannot be evaluated (unsupported or invalid)
}

// View is one entry of "views".
type View struct {
	Type      string
	Name      string
	Filters   *FilterNode
	Order     []string
	Sort      []SortSpec
	GroupBy   *SortSpec
	Limit     int
	Summaries map[string]string
	Supported bool
	Notice    string
}

// Base is a parsed ".base" file.
type Base struct {
	Filters      *FilterNode
	Formulas     map[string]*Formula
	FormulaOrder []string
	DisplayNames map[string]string
	Views        []View
	Notices      []string // problems found while parsing (unsupported constructs, bad expressions)
}

// SupportedViewTypes are the view types this implementation renders.
var SupportedViewTypes = map[string]bool{"table": true, "cards": true}

// Parse reads a .base document. It never fails on unsupported constructs: they
// are reported in Base.Notices / View.Notice. An error is returned only when
// the text is not YAML or not a mapping.
func Parse(src []byte) (*Base, error) {
	var root any
	if err := yaml.Unmarshal(src, &root); err != nil {
		return nil, fmt.Errorf("invalid YAML: %w", err)
	}
	b := &Base{Formulas: map[string]*Formula{}, DisplayNames: map[string]string{}}
	if root == nil {
		root = map[string]any{}
	}
	m, ok := root.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("a base must be a YAML mapping")
	}
	if f, ok := m["filters"]; ok {
		b.Filters = b.parseFilter(f, "filters")
	}
	if fm, ok := m["formulas"].(map[string]any); ok {
		for _, name := range sortedKeys(fm) {
			src, _ := fm[name].(string)
			f := &Formula{Name: name, Src: src}
			if _, isStr := fm[name].(string); !isStr {
				f.Err = "a formula must be a text expression"
			} else if e, err := ParseExpr(src); err != nil {
				f.Err = err.Error()
			} else {
				f.Expr = e
			}
			if f.Err != "" {
				b.Notices = append(b.Notices, fmt.Sprintf("formula %q: %s", name, f.Err))
			}
			b.Formulas[name] = f
			b.FormulaOrder = append(b.FormulaOrder, name)
		}
	}
	if pm, ok := m["properties"].(map[string]any); ok {
		for k, v := range pm {
			if cfg, ok := v.(map[string]any); ok {
				if dn, ok := cfg["displayName"].(string); ok && dn != "" {
					b.DisplayNames[k] = dn
				}
			}
		}
	}
	views, _ := m["views"].([]any)
	for i, raw := range views {
		b.Views = append(b.Views, b.parseView(i, raw))
	}
	return b, nil
}

func (b *Base) parseView(i int, raw any) View {
	v := View{Supported: true}
	vm, ok := raw.(map[string]any)
	if !ok {
		v.Name = fmt.Sprintf("View %d", i+1)
		v.Supported, v.Notice = false, "this view is not a mapping"
		b.Notices = append(b.Notices, fmt.Sprintf("view %d: not a mapping", i+1))
		return v
	}
	v.Type, _ = vm["type"].(string)
	v.Name, _ = vm["name"].(string)
	if v.Name == "" {
		v.Name = fmt.Sprintf("View %d", i+1)
	}
	if !SupportedViewTypes[v.Type] {
		v.Supported = false
		v.Notice = fmt.Sprintf("view type %q is not supported", v.Type)
		b.Notices = append(b.Notices, fmt.Sprintf("view %q: type %q is not supported", v.Name, v.Type))
	}
	if f, ok := vm["filters"]; ok {
		v.Filters = b.parseFilter(f, "view "+v.Name)
	}
	if order, ok := vm["order"].([]any); ok {
		for _, o := range order {
			if s, ok := o.(string); ok {
				v.Order = append(v.Order, s)
			}
		}
	}
	if sorts, ok := vm["sort"].([]any); ok {
		for _, s := range sorts {
			if sm, ok := s.(map[string]any); ok {
				if p, _ := sm["property"].(string); p != "" {
					v.Sort = append(v.Sort, SortSpec{Property: p, Direction: normDir(sm["direction"])})
				}
			}
		}
	}
	if g, ok := vm["groupBy"].(map[string]any); ok {
		if p, _ := g["property"].(string); p != "" {
			v.GroupBy = &SortSpec{Property: p, Direction: normDir(g["direction"])}
		}
	}
	switch l := vm["limit"].(type) {
	case int:
		v.Limit = l
	case float64:
		v.Limit = int(l)
	}
	if sm, ok := vm["summaries"].(map[string]any); ok {
		v.Summaries = map[string]string{}
		for k, s := range sm {
			if name, ok := s.(string); ok {
				v.Summaries[k] = name
			}
		}
	}
	return v
}

func normDir(d any) string {
	if s, ok := d.(string); ok && strings.EqualFold(s, "DESC") {
		return "DESC"
	}
	return "ASC"
}

func (b *Base) parseFilter(raw any, where string) *FilterNode {
	switch t := raw.(type) {
	case string:
		n := &FilterNode{Op: "expr", Src: t}
		e, err := ParseExpr(t)
		if err != nil {
			n.Err = err.Error()
			b.Notices = append(b.Notices, fmt.Sprintf("%s: filter %q is not supported: %s", where, t, n.Err))
		} else {
			n.Expr = e
		}
		return n
	case map[string]any:
		if len(t) == 1 {
			for _, op := range []string{"and", "or", "not"} {
				if children, ok := t[op]; ok {
					n := &FilterNode{Op: op}
					list, isList := children.([]any)
					if !isList {
						list = []any{children}
					}
					for _, c := range list {
						n.Children = append(n.Children, b.parseFilter(c, where))
					}
					return n
				}
			}
		}
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		n := &FilterNode{Op: "expr", Src: "{" + strings.Join(keys, ", ") + "}", Err: "unsupported filter structure"}
		b.Notices = append(b.Notices, fmt.Sprintf("%s: unsupported filter structure {%s}", where, strings.Join(keys, ", ")))
		return n
	}
	n := &FilterNode{Op: "expr", Src: fmt.Sprint(raw), Err: "a filter must be an expression or an and/or/not group"}
	b.Notices = append(b.Notices, fmt.Sprintf("%s: a filter must be an expression or an and/or/not group", where))
	return n
}

// Match evaluates the tree for env's note. Nodes that cannot be understood
// are neutral (they do not hide rows); runtime errors make a leaf false.
func (f *FilterNode) Match(env *Env) bool {
	if f == nil {
		return true
	}
	switch f.Op {
	case "and":
		for _, c := range f.Children {
			if !c.Match(env) {
				return false
			}
		}
		return true
	case "or":
		if len(f.Children) == 0 {
			return true
		}
		for _, c := range f.Children {
			if c.Match(env) {
				return true
			}
		}
		return false
	case "not":
		for _, c := range f.Children {
			if c.Match(env) {
				return false
			}
		}
		return true
	}
	if f.Err != "" {
		return true
	}
	v, err := env.Eval(f.Expr)
	return err == nil && Truthy(v)
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// Chip is a read-only summary of a filter for the UI.
type Chip struct {
	Text   string `json:"text"`
	Simple bool   `json:"simple"` // a plain expression that the UI may remove
	Index  int    `json:"index"`  // index inside the top-level "and" list, -1 otherwise
	Error  string `json:"error,omitempty"`
}

// Describe renders a filter tree as short text.
func (f *FilterNode) Describe() string {
	if f == nil {
		return ""
	}
	if f.Op == "expr" {
		return f.Src
	}
	parts := make([]string, len(f.Children))
	for i, c := range f.Children {
		parts[i] = c.Describe()
	}
	return f.Op + "(" + strings.Join(parts, "; ") + ")"
}

// Chips lists the top-level conditions of a filter tree.
func (f *FilterNode) Chips() []Chip {
	if f == nil {
		return nil
	}
	if f.Op == "and" {
		out := make([]Chip, len(f.Children))
		for i, c := range f.Children {
			out[i] = Chip{Text: c.Describe(), Simple: c.Op == "expr", Index: i, Error: c.Err}
		}
		return out
	}
	return []Chip{{Text: f.Describe(), Simple: false, Index: -1, Error: f.Err}}
}
