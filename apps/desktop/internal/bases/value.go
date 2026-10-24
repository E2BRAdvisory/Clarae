// Package bases implements Obsidian-compatible ".base" files: the YAML model
// (filters, formulas, views), a small expression language (hand-rolled parser
// and evaluator, no eval), the query engine over indexed properties and
// node-preserving edits of the YAML so that unknown content survives.
package bases

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Date is a date or a datetime value.
type Date struct {
	T       time.Time
	HasTime bool
}

// Duration is a length of time in milliseconds (the result of date - date).
type Duration struct{ Ms float64 }

// Link is a wiki link value ([[target|display]]).
type Link struct{ Target, Display string }

// Value kinds reported to the UI.
const (
	KindText     = "text"
	KindNumber   = "number"
	KindBool     = "checkbox"
	KindDate     = "date"
	KindDateTime = "datetime"
	KindList     = "list"
	KindLink     = "link"
	KindDuration = "duration"
	KindNull     = "null"
	KindError    = "error"
)

var (
	dateRe     = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	dateTimeRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$`)
	linkRe     = regexp.MustCompile(`^\[\[([^\]|]+)(?:\|([^\]]*))?\]\]$`)
	durationRe = regexp.MustCompile(`^\s*(-?\d+(?:\.\d+)?)\s*([a-zA-Z]+)\s*$`)
)

// KindOf returns the UI kind of a value.
func KindOf(v any) string {
	switch t := v.(type) {
	case nil:
		return KindNull
	case bool:
		return KindBool
	case float64:
		return KindNumber
	case string:
		return KindText
	case Date:
		if t.HasTime {
			return KindDateTime
		}
		return KindDate
	case Duration:
		return KindDuration
	case Link:
		return KindLink
	case []any:
		return KindList
	}
	return KindText
}

// ParseDate parses an ISO date or datetime string.
func ParseDate(s string) (Date, bool) {
	s = strings.TrimSpace(s)
	if dateRe.MatchString(s) {
		t, err := time.ParseInLocation("2006-01-02", s, time.Local)
		return Date{T: t}, err == nil
	}
	if dateTimeRe.MatchString(s) {
		for _, layout := range []string{
			"2006-01-02T15:04:05.999999999Z07:00", "2006-01-02T15:04:05Z07:00", "2006-01-02T15:04Z07:00",
			"2006-01-02 15:04:05.999999999", "2006-01-02 15:04:05", "2006-01-02 15:04",
			"2006-01-02T15:04:05.999999999", "2006-01-02T15:04:05", "2006-01-02T15:04",
			"2006-01-02T15:04:05.999999999-0700", "2006-01-02T15:04:05-0700",
		} {
			if t, err := time.ParseInLocation(layout, s, time.Local); err == nil {
				return Date{T: t, HasTime: true}, true
			}
		}
	}
	return Date{}, false
}

// FromJSON converts a decoded JSON/YAML property value to an expression
// value; kind is the indexed kind (date, datetime, ...), "" to infer.
func FromJSON(raw any, kind string) any {
	switch t := raw.(type) {
	case nil:
		return nil
	case bool:
		return t
	case float64:
		return t
	case int:
		return float64(t)
	case int64:
		return float64(t)
	case string:
		if kind == "date" || kind == "datetime" || kind == "" {
			if d, ok := ParseDate(t); ok {
				return d
			}
		}
		if m := linkRe.FindStringSubmatch(t); m != nil {
			return Link{Target: m[1], Display: m[2]}
		}
		return t
	case []any:
		out := make([]any, len(t))
		for i, e := range t {
			out[i] = FromJSON(e, "")
		}
		return out
	case []string:
		out := make([]any, len(t))
		for i, e := range t {
			out[i] = FromJSON(e, "")
		}
		return out
	}
	return fmt.Sprint(raw)
}

// ToJSON converts a value to a JSON-friendly one for the UI.
func ToJSON(v any) any {
	switch t := v.(type) {
	case Date:
		if t.HasTime {
			return t.T.Format("2006-01-02T15:04:05")
		}
		return t.T.Format("2006-01-02")
	case Duration:
		return t.Ms
	case Link:
		if t.Display != "" {
			return "[[" + t.Target + "|" + t.Display + "]]"
		}
		return "[[" + t.Target + "]]"
	case []any:
		out := make([]any, len(t))
		for i, e := range t {
			out[i] = ToJSON(e)
		}
		return out
	case float64:
		if math.IsNaN(t) || math.IsInf(t, 0) {
			return nil
		}
	}
	return v
}

// Truthy implements the language truthiness: null, false, 0, "" and [] are false.
func Truthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case float64:
		return t != 0 && !math.IsNaN(t)
	case string:
		return t != ""
	case []any:
		return len(t) > 0
	}
	return true
}

// Str renders a value as text (used by string concatenation and toString).
func Str(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case bool:
		return strconv.FormatBool(t)
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case Date:
		s, _ := ToJSON(t).(string)
		return s
	case Duration:
		return strconv.FormatFloat(t.Ms, 'f', -1, 64) + "ms"
	case Link:
		if t.Display != "" {
			return t.Display
		}
		return t.Target
	case []any:
		parts := make([]string, len(t))
		for i, e := range t {
			parts[i] = Str(e)
		}
		return strings.Join(parts, ", ")
	}
	return fmt.Sprint(v)
}

// Equal is the == operator.
func Equal(a, b any) bool {
	switch x := a.(type) {
	case nil:
		return b == nil
	case bool:
		y, ok := b.(bool)
		return ok && x == y
	case float64:
		y, ok := b.(float64)
		return ok && x == y
	case string:
		switch y := b.(type) {
		case string:
			return x == y
		case Link:
			return x == y.Target || x == Str(y)
		case Date:
			if d, ok := ParseDate(x); ok {
				return d.T.Equal(y.T)
			}
		}
		return false
	case Date:
		switch y := b.(type) {
		case Date:
			return x.T.Equal(y.T)
		case string:
			if d, ok := ParseDate(y); ok {
				return x.T.Equal(d.T)
			}
		}
		return false
	case Duration:
		y, ok := b.(Duration)
		return ok && x.Ms == y.Ms
	case Link:
		switch y := b.(type) {
		case Link:
			return x.Target == y.Target
		case string:
			return y == x.Target || y == Str(x)
		}
		return false
	case []any:
		y, ok := b.([]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for i := range x {
			if !Equal(x[i], y[i]) {
				return false
			}
		}
		return true
	}
	return false
}

// Compare orders two values of the same family; ok is false when they are
// not comparable. Used by <, >, sort and min/max.
func Compare(a, b any) (int, bool) {
	if y, ok := b.(Link); ok {
		b = Str(y)
	}
	switch x := a.(type) {
	case float64:
		if y, ok := b.(float64); ok {
			return cmpF(x, y), true
		}
	case string:
		switch y := b.(type) {
		case string:
			return cmpS(x, y), true
		case Date:
			if d, ok := ParseDate(x); ok {
				return cmpT(d.T, y.T), true
			}
		}
	case Date:
		switch y := b.(type) {
		case Date:
			return cmpT(x.T, y.T), true
		case string:
			if d, ok := ParseDate(y); ok {
				return cmpT(x.T, d.T), true
			}
		}
	case Duration:
		if y, ok := b.(Duration); ok {
			return cmpF(x.Ms, y.Ms), true
		}
	case bool:
		if y, ok := b.(bool); ok {
			return cmpF(b2f(x), b2f(y)), true
		}
	case Link:
		return Compare(Str(x), b)
	}
	return 0, false
}

// cmpS compares case-insensitively, falling back to the exact text for a stable order.
func cmpS(x, y string) int {
	if c := strings.Compare(strings.ToLower(x), strings.ToLower(y)); c != 0 {
		return c
	}
	return strings.Compare(x, y)
}

func b2f(b bool) float64 {
	if b {
		return 1
	}
	return 0
}

func cmpF(a, b float64) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

func cmpT(a, b time.Time) int {
	switch {
	case a.Before(b):
		return -1
	case a.After(b):
		return 1
	}
	return 0
}

// SortCompare is a total order used for sorting rows: nulls last, then by
// family, so that mixed columns sort deterministically.
func SortCompare(a, b any) int {
	if a == nil || b == nil {
		switch {
		case a == nil && b == nil:
			return 0
		case a == nil:
			return 1
		}
		return -1
	}
	if c, ok := Compare(a, b); ok {
		return c
	}
	return rank(a) - rank(b)
}

func rank(v any) int {
	switch v.(type) {
	case float64:
		return 1
	case string, Link:
		return 2
	case Date:
		return 3
	case bool:
		return 4
	case []any:
		return 5
	}
	return 6
}

// ParseDuration parses "1d", "2 weeks", "3h"... into a Duration.
func ParseDuration(s string) (Duration, bool) {
	m := durationRe.FindStringSubmatch(s)
	if m == nil {
		return Duration{}, false
	}
	n, _ := strconv.ParseFloat(m[1], 64)
	var unit float64
	switch strings.ToLower(m[2]) {
	case "ms", "millisecond", "milliseconds":
		unit = 1
	case "s", "sec", "secs", "second", "seconds":
		unit = 1000
	case "m", "min", "mins", "minute", "minutes":
		unit = 60_000
	case "h", "hr", "hrs", "hour", "hours":
		unit = 3_600_000
	case "d", "day", "days":
		unit = 86_400_000
	case "w", "week", "weeks":
		unit = 7 * 86_400_000
	case "mo", "month", "months":
		unit = 30 * 86_400_000
	case "y", "yr", "yrs", "year", "years":
		unit = 365 * 86_400_000
	default:
		return Duration{}, false
	}
	return Duration{Ms: n * unit}, true
}

// FormatDate renders a date with moment-style tokens (YYYY MM DD HH mm ss ...);
// text between [brackets] is copied verbatim.
func FormatDate(d Date, layout string) string {
	t := d.T
	var b strings.Builder
	rs := []rune(layout)
	for i := 0; i < len(rs); {
		c := rs[i]
		if c == '[' {
			j := i + 1
			for j < len(rs) && rs[j] != ']' {
				j++
			}
			b.WriteString(string(rs[i+1 : min(j, len(rs))]))
			i = j + 1
			continue
		}
		n := 1
		for i+n < len(rs) && rs[i+n] == c {
			n++
		}
		tok := strings.Repeat(string(c), n)
		if s, ok := dateToken(t, tok); ok {
			b.WriteString(s)
		} else {
			b.WriteString(tok)
		}
		i += n
	}
	return b.String()
}

func dateToken(t time.Time, tok string) (string, bool) {
	h12 := t.Hour() % 12
	if h12 == 0 {
		h12 = 12
	}
	switch tok {
	case "YYYY":
		return fmt.Sprintf("%04d", t.Year()), true
	case "YY":
		return fmt.Sprintf("%02d", t.Year()%100), true
	case "MMMM":
		return t.Month().String(), true
	case "MMM":
		return t.Month().String()[:3], true
	case "MM":
		return fmt.Sprintf("%02d", int(t.Month())), true
	case "M":
		return strconv.Itoa(int(t.Month())), true
	case "DD":
		return fmt.Sprintf("%02d", t.Day()), true
	case "D":
		return strconv.Itoa(t.Day()), true
	case "dddd":
		return t.Weekday().String(), true
	case "ddd":
		return t.Weekday().String()[:3], true
	case "HH":
		return fmt.Sprintf("%02d", t.Hour()), true
	case "H":
		return strconv.Itoa(t.Hour()), true
	case "hh":
		return fmt.Sprintf("%02d", h12), true
	case "h":
		return strconv.Itoa(h12), true
	case "mm":
		return fmt.Sprintf("%02d", t.Minute()), true
	case "m":
		return strconv.Itoa(t.Minute()), true
	case "ss":
		return fmt.Sprintf("%02d", t.Second()), true
	case "s":
		return strconv.Itoa(t.Second()), true
	case "SSS":
		return fmt.Sprintf("%03d", t.Nanosecond()/1e6), true
	case "A":
		if t.Hour() < 12 {
			return "AM", true
		}
		return "PM", true
	case "a":
		if t.Hour() < 12 {
			return "am", true
		}
		return "pm", true
	}
	return "", false
}
