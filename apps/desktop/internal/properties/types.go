// Package properties handles typed frontmatter properties (§2.2.1
// "Properties"): the six types, type inference, coercion, the per-vault type
// schema (.nodus/types.json) and edits of a note's frontmatter that preserve
// key order and comments.
package properties

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// Kind is a property type.
type Kind string

// Property types.
const (
	Text     Kind = "text"
	List     Kind = "list"
	Number   Kind = "number"
	Checkbox Kind = "checkbox"
	Date     Kind = "date"
	DateTime Kind = "datetime"
)

// Kinds lists every valid type.
var Kinds = []Kind{Text, List, Number, Checkbox, Date, DateTime}

// Valid reports whether k is one of the known types.
func (k Kind) Valid() bool {
	for _, v := range Kinds {
		if k == v {
			return true
		}
	}
	return false
}

var (
	dateRe     = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	dateTimeRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$`)
)

// Infer guesses the type of a parsed YAML value.
func Infer(v any) Kind {
	switch t := v.(type) {
	case bool:
		return Checkbox
	case int, int64, float64:
		return Number
	case []any, []string:
		return List
	case string:
		switch {
		case dateRe.MatchString(t):
			return Date
		case dateTimeRe.MatchString(t):
			return DateTime
		}
	}
	return Text
}

// Coerce converts raw (as sent by the UI: JSON values) to a value valid for
// kind k, or returns an error describing why it is not acceptable.
func Coerce(k Kind, raw any) (any, error) {
	switch k {
	case Text:
		switch t := raw.(type) {
		case nil:
			return "", nil
		case string:
			return t, nil
		default:
			return fmt.Sprint(t), nil
		}
	case Number:
		switch t := raw.(type) {
		case float64:
			return t, nil
		case int:
			return t, nil
		case string:
			f, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
			if err != nil {
				return nil, fmt.Errorf("%q is not a number", t)
			}
			return f, nil
		}
	case Checkbox:
		switch t := raw.(type) {
		case bool:
			return t, nil
		case string:
			b, err := strconv.ParseBool(strings.TrimSpace(t))
			if err != nil {
				return nil, fmt.Errorf("%q is not a boolean", t)
			}
			return b, nil
		}
	case Date:
		if s, ok := raw.(string); ok && dateRe.MatchString(s) {
			return s, nil
		}
		return nil, fmt.Errorf("%v is not a date (YYYY-MM-DD)", raw)
	case DateTime:
		if s, ok := raw.(string); ok && dateTimeRe.MatchString(s) {
			return s, nil
		}
		return nil, fmt.Errorf("%v is not a date and time (YYYY-MM-DDTHH:MM)", raw)
	case List:
		switch t := raw.(type) {
		case []any:
			return t, nil
		case []string:
			out := make([]any, len(t))
			for i, s := range t {
				out[i] = s
			}
			return out, nil
		case string:
			out := []any{}
			for _, part := range strings.Split(t, ",") {
				if p := strings.TrimSpace(part); p != "" {
					out = append(out, p)
				}
			}
			return out, nil
		case nil:
			return []any{}, nil
		}
	}
	return nil, fmt.Errorf("value %v is not valid for type %s", raw, k)
}

// Schema is the per-vault mapping property name -> type (.nodus/types.json).
type Schema map[string]Kind

// ParseSchema decodes and validates the content of types.json; an empty input is an empty schema.
func ParseSchema(data []byte) (Schema, error) {
	s := Schema{}
	if len(strings.TrimSpace(string(data))) == 0 {
		return s, nil
	}
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, fmt.Errorf("types.json: %w", err)
	}
	for k, v := range s {
		if !v.Valid() {
			return nil, fmt.Errorf("types.json: property %q has unknown type %q", k, v)
		}
	}
	return s, nil
}

// Marshal encodes the schema with stable key order.
func (s Schema) Marshal() ([]byte, error) {
	b, err := json.MarshalIndent(s, "", "  ") // encoding/json sorts map keys
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}

// KindFor returns the declared type of key (case-insensitive) or the inferred one.
func (s Schema) KindFor(key string, value any) Kind {
	if k, ok := s[key]; ok {
		return k
	}
	for name, k := range s {
		if strings.EqualFold(name, key) {
			return k
		}
	}
	return Infer(value)
}
