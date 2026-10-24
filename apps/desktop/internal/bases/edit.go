package bases

import (
	"bytes"
	"errors"
	"fmt"
	"strings"

	"gopkg.in/yaml.v3"
)

// ViewPatch is a set of changes to one view. Nil/false fields leave the
// matching YAML untouched; everything not mentioned (unknown keys, comments,
// other views) is preserved.
type ViewPatch struct {
	Order         *[]string   `json:"order,omitempty"`
	Sort          *[]SortSpec `json:"sort,omitempty"` // empty list removes "sort"
	GroupBy       *SortSpec   `json:"groupBy,omitempty"`
	ClearGroupBy  bool        `json:"clearGroupBy,omitempty"`
	Limit         *int        `json:"limit,omitempty"` // 0 removes "limit"
	AddFilter     string      `json:"addFilter,omitempty"`
	RemoveFilter  *int        `json:"removeFilter,omitempty"` // index in the top-level "and" list
	RenameViewTo  string      `json:"renameView,omitempty"`
	SetDisplayFor string      `json:"setDisplayFor,omitempty"` // property id whose displayName changes
	DisplayName   string      `json:"displayName,omitempty"`
}

// ApplyViewPatch edits src (a .base document) and returns the new content.
func ApplyViewPatch(src []byte, viewIndex int, p ViewPatch) ([]byte, error) {
	var root yaml.Node
	if err := yaml.Unmarshal(src, &root); err != nil {
		return nil, fmt.Errorf("invalid YAML: %w", err)
	}
	if root.Kind != yaml.DocumentNode || len(root.Content) == 0 || root.Content[0].Kind != yaml.MappingNode {
		return nil, errors.New("the base has no views to edit")
	}
	top := root.Content[0]
	views := mapGet(top, "views")
	if views == nil || views.Kind != yaml.SequenceNode || viewIndex < 0 || viewIndex >= len(views.Content) {
		return nil, fmt.Errorf("view %d does not exist", viewIndex)
	}
	view := views.Content[viewIndex]
	if view.Kind != yaml.MappingNode {
		return nil, errors.New("the view is not a mapping")
	}
	if p.Order != nil {
		mapSet(view, "order", encode(*p.Order))
	}
	if p.Sort != nil {
		if len(*p.Sort) == 0 {
			mapDel(view, "sort")
		} else {
			mapSet(view, "sort", encodeOrdered(*p.Sort))
		}
	}
	if p.ClearGroupBy {
		mapDel(view, "groupBy")
	} else if p.GroupBy != nil {
		mapSet(view, "groupBy", encodeOrdered([]SortSpec{*p.GroupBy}).Content[0])
	}
	if p.Limit != nil {
		if *p.Limit <= 0 {
			mapDel(view, "limit")
		} else {
			mapSet(view, "limit", encode(*p.Limit))
		}
	}
	if p.RenameViewTo != "" {
		mapSet(view, "name", encode(p.RenameViewTo))
	}
	if p.AddFilter != "" {
		if err := addFilter(view, p.AddFilter); err != nil {
			return nil, err
		}
	}
	if p.RemoveFilter != nil {
		if err := removeFilter(view, *p.RemoveFilter); err != nil {
			return nil, err
		}
	}
	if p.SetDisplayFor != "" {
		props := mapGet(top, "properties")
		if props == nil || props.Kind != yaml.MappingNode {
			props = &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
			mapSet(top, "properties", props)
		}
		entry := mapGet(props, p.SetDisplayFor)
		if entry == nil || entry.Kind != yaml.MappingNode {
			entry = &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
			mapSet(props, p.SetDisplayFor, entry)
		}
		if p.DisplayName == "" {
			mapDel(entry, "displayName")
		} else {
			mapSet(entry, "displayName", encode(p.DisplayName))
		}
	}
	return render(&root)
}

func addFilter(view *yaml.Node, expr string) error {
	if _, err := ParseExpr(expr); err != nil {
		return fmt.Errorf("invalid filter: %w", err)
	}
	leaf := encode(expr)
	cur := mapGet(view, "filters")
	if cur == nil {
		and := &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq", Content: []*yaml.Node{leaf}}
		mapSet(view, "filters", &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map", Content: []*yaml.Node{encode("and"), and}})
		return nil
	}
	if cur.Kind == yaml.MappingNode && len(cur.Content) == 2 && cur.Content[0].Value == "and" && cur.Content[1].Kind == yaml.SequenceNode {
		cur.Content[1].Content = append(cur.Content[1].Content, leaf)
		return nil
	}
	// Any other shape: keep it intact as the first member of a new "and".
	and := &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq", Content: []*yaml.Node{cur, leaf}}
	mapSet(view, "filters", &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map", Content: []*yaml.Node{encode("and"), and}})
	return nil
}

func removeFilter(view *yaml.Node, idx int) error {
	cur := mapGet(view, "filters")
	if cur == nil || cur.Kind != yaml.MappingNode || len(cur.Content) != 2 || cur.Content[0].Value != "and" || cur.Content[1].Kind != yaml.SequenceNode {
		return errors.New("only filters of the top-level \"and\" list can be removed here; edit the YAML")
	}
	seq := cur.Content[1]
	if idx < 0 || idx >= len(seq.Content) {
		return fmt.Errorf("filter %d does not exist", idx)
	}
	seq.Content = append(seq.Content[:idx], seq.Content[idx+1:]...)
	if len(seq.Content) == 0 {
		mapDel(view, "filters")
	}
	return nil
}

func mapGet(m *yaml.Node, key string) *yaml.Node {
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			return m.Content[i+1]
		}
	}
	return nil
}

// mapSet replaces the value of key in place (keeping its comments and position) or appends it.
func mapSet(m *yaml.Node, key string, val *yaml.Node) {
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			old := m.Content[i+1]
			val.HeadComment, val.LineComment, val.FootComment = old.HeadComment, old.LineComment, old.FootComment
			m.Content[i+1] = val
			return
		}
	}
	m.Content = append(m.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}, val)
}

func mapDel(m *yaml.Node, key string) {
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			m.Content = append(m.Content[:i], m.Content[i+2:]...)
			return
		}
	}
}

func encode(v any) *yaml.Node {
	var n yaml.Node
	if err := n.Encode(v); err != nil {
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: fmt.Sprint(v)}
	}
	return &n
}

// encodeOrdered encodes sort specs as mappings with "property" before "direction".
func encodeOrdered(specs []SortSpec) *yaml.Node {
	seq := &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
	for _, s := range specs {
		seq.Content = append(seq.Content, &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map", Content: []*yaml.Node{
			encode("property"), encode(s.Property), encode("direction"), encode(normDir(s.Direction)),
		}})
	}
	return seq
}

func render(root *yaml.Node) ([]byte, error) {
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(root); err != nil {
		return nil, err
	}
	if err := enc.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// NewBase returns a minimal base with a default table of the notes in folder
// ("" = the whole vault); only Markdown notes are listed. Obsidian-compatible.
func NewBase(folder string) []byte {
	var b strings.Builder
	folder = strings.Trim(folder, "/")
	b.WriteString("filters:\n  and:\n    - file.ext == \"md\"\n")
	if folder != "" {
		expr := "file.inFolder(" + jsonString(folder) + ")"
		b.WriteString("    - '" + strings.ReplaceAll(expr, "'", "''") + "'\n")
	}
	b.WriteString("views:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - file.mtime\n")
	return []byte(b.String())
}

func jsonString(s string) string {
	// Double-quoted YAML scalars are JSON compatible for the characters allowed in folder names.
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`)
	return `"` + r.Replace(s) + `"`
}
