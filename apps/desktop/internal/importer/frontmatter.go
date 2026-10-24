package importer

import (
	"bytes"
	"regexp"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Prop is one frontmatter property, in insertion order.
type Prop struct {
	Key   string
	Value any // string, bool, int64, float64, []string
}

var (
	dateRe     = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	dateTimeRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$`)
)

// buildNote renders properties as a YAML frontmatter block followed by body.
func buildNote(props []Prop, body string) []byte {
	var out bytes.Buffer
	if len(props) > 0 {
		root := &yaml.Node{Kind: yaml.MappingNode}
		seen := map[string]bool{}
		for _, p := range props {
			if p.Key == "" || seen[p.Key] || p.Value == nil {
				continue
			}
			seen[p.Key] = true
			var v yaml.Node
			if err := v.Encode(p.Value); err != nil {
				continue
			}
			if s, ok := p.Value.(string); ok && v.Kind == yaml.ScalarNode && (dateRe.MatchString(s) || dateTimeRe.MatchString(s)) {
				v.Tag, v.Style = "!!timestamp", 0
			}
			if v.Kind == yaml.SequenceNode {
				v.Style = yaml.FlowStyle
			}
			root.Content = append(root.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: p.Key}, &v)
		}
		if len(root.Content) > 0 {
			if b, err := yaml.Marshal(root); err == nil {
				out.WriteString("---\n")
				out.Write(b)
				out.WriteString("---\n\n")
			}
		}
	}
	out.WriteString(strings.TrimLeft(body, "\n"))
	if !strings.HasSuffix(body, "\n") {
		out.WriteByte('\n')
	}
	return out.Bytes()
}

// tagName turns a free-form label into a valid tag (no spaces or '#').
func tagName(s string) string {
	s = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(s), "#"))
	var b strings.Builder
	for _, r := range s {
		switch {
		case r == ' ' || r == '\t':
			b.WriteByte('-')
		case strings.ContainsRune(",;#[]{}()\"'`\\|<>:*?", r):
		default:
			b.WriteRune(r)
		}
	}
	return strings.Trim(b.String(), "-")
}

func tagList(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		t := tagName(s)
		if t == "" || seen[strings.ToLower(t)] {
			continue
		}
		seen[strings.ToLower(t)] = true
		out = append(out, t)
	}
	return out
}

var (
	intRe   = regexp.MustCompile(`^-?(0|[1-9][0-9]{0,14})$`)
	floatRe = regexp.MustCompile(`^-?(0|[1-9][0-9]{0,14})\.[0-9]{1,15}$`)
)

// inferValue gives a CSV/Notion cell the most specific frontmatter type it can have.
func inferValue(s string) any {
	t := strings.TrimSpace(s)
	switch {
	case t == "":
		return nil
	case strings.EqualFold(t, "true"):
		return true
	case strings.EqualFold(t, "false"):
		return false
	case intRe.MatchString(t):
		i, _ := strconv.ParseInt(t, 10, 64)
		return i
	case floatRe.MatchString(t):
		f, _ := strconv.ParseFloat(t, 64)
		return f
	case dateRe.MatchString(t):
		if _, err := time.Parse("2006-01-02", t); err == nil {
			return t
		}
	case dateTimeRe.MatchString(t):
		return t
	}
	return s
}

// isoTime formats a time as a frontmatter date-time.
func isoTime(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05Z") }
