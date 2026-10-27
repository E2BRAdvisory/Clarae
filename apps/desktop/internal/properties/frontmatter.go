package properties

import (
	"bytes"
	"errors"
	"fmt"
	"strings"

	"gopkg.in/yaml.v3"

	"memobrain/apps/desktop/internal/parser"
)

// reserved keys keep their meaning (tags, aliases) and are editable like any other.

// Set writes key = value in the note's frontmatter (creating the block when
// absent) and returns the new file content. Existing key order and comments
// are preserved; value must already be coerced.
func Set(src []byte, key string, value any) ([]byte, error) {
	if strings.TrimSpace(key) == "" {
		return nil, errors.New("property name is empty")
	}
	body, _, fm := parser.SplitFrontmatter(src)
	crlf := bytes.Contains(src[:min(len(src), 200)], []byte("\r\n"))
	var root yaml.Node
	if fm != nil {
		if err := yaml.Unmarshal(fm, &root); err != nil {
			return nil, fmt.Errorf("frontmatter is not valid YAML: %w", err)
		}
	}
	mapping := ensureMapping(&root)

	var valNode yaml.Node
	if err := valNode.Encode(value); err != nil {
		return nil, err
	}
	// Dates are written plain (due: 2026-12-01), as Obsidian does, not quoted.
	if str, ok := value.(string); ok && valNode.Kind == yaml.ScalarNode && (dateRe.MatchString(str) || dateTimeRe.MatchString(str)) {
		valNode.Tag, valNode.Style = "!!timestamp", 0
	}
	if valNode.Kind == yaml.SequenceNode {
		valNode.Style = yaml.FlowStyle // lists as [a, b], the usual Obsidian style
	}
	for i := 0; i+1 < len(mapping.Content); i += 2 {
		if mapping.Content[i].Value == key {
			old := mapping.Content[i+1]
			valNode.HeadComment, valNode.LineComment, valNode.FootComment = old.HeadComment, old.LineComment, old.FootComment
			mapping.Content[i+1] = &valNode
			return render(&root, body, crlf)
		}
	}
	keyNode := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}
	mapping.Content = append(mapping.Content, keyNode, &valNode)
	return render(&root, body, crlf)
}

// Delete removes key from the frontmatter; the block disappears when it becomes empty.
func Delete(src []byte, key string) ([]byte, error) {
	body, _, fm := parser.SplitFrontmatter(src)
	if fm == nil {
		return src, nil
	}
	crlf := bytes.Contains(src[:min(len(src), 200)], []byte("\r\n"))
	var root yaml.Node
	if err := yaml.Unmarshal(fm, &root); err != nil {
		return nil, fmt.Errorf("frontmatter is not valid YAML: %w", err)
	}
	mapping := ensureMapping(&root)
	kept := mapping.Content[:0]
	for i := 0; i+1 < len(mapping.Content); i += 2 {
		if mapping.Content[i].Value != key {
			kept = append(kept, mapping.Content[i], mapping.Content[i+1])
		}
	}
	mapping.Content = kept
	return render(&root, body, crlf)
}

// ensureMapping returns the top-level mapping of a (possibly empty) document.
func ensureMapping(root *yaml.Node) *yaml.Node {
	if root.Kind == 0 {
		root.Kind = yaml.DocumentNode
	}
	if len(root.Content) == 0 {
		root.Content = []*yaml.Node{{Kind: yaml.MappingNode, Tag: "!!map"}}
	}
	return root.Content[0]
}

func render(root *yaml.Node, body []byte, crlf bool) ([]byte, error) {
	mapping := root.Content[0]
	var out bytes.Buffer
	if len(mapping.Content) > 0 {
		var y bytes.Buffer
		enc := yaml.NewEncoder(&y)
		enc.SetIndent(2)
		if err := enc.Encode(root); err != nil {
			return nil, err
		}
		_ = enc.Close()
		out.WriteString("---\n")
		out.Write(y.Bytes())
		out.WriteString("---\n")
	}
	out.Write(body)
	res := out.Bytes()
	if crlf {
		res = bytes.ReplaceAll(bytes.ReplaceAll(res, []byte("\r\n"), []byte("\n")), []byte("\n"), []byte("\r\n"))
	}
	return res, nil
}
