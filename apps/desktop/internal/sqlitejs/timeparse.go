package sqlitejs

import (
	"strings"
	"time"
)

// timeLayouts are the text forms SQLite and Go programs store dates in; modernc.org/sqlite accepts
// the same set when it reads a DATE, DATETIME or TIMESTAMP column. Zone-less values are UTC.
var timeLayouts = []string{
	"2006-01-02 15:04:05.999999999-07:00",
	"2006-01-02T15:04:05.999999999-07:00",
	"2006-01-02 15:04:05.999999999Z07:00",
	"2006-01-02T15:04:05.999999999Z07:00",
	"2006-01-02 15:04:05.999999999 -0700 MST", // time.Time.String()
	"2006-01-02 15:04:05.999999999",
	"2006-01-02T15:04:05.999999999",
	"2006-01-02 15:04",
	"2006-01-02T15:04",
	"2006-01-02",
}

// isTimeType reports whether a declared column type holds a point in time.
func isTimeType(decl string) bool {
	switch strings.ToUpper(decl) {
	case "DATE", "DATETIME", "TIMESTAMP":
		return true
	}
	return false
}

// parseTime reads a stored date; ok is false when s is none of the known forms.
func parseTime(s string) (t time.Time, ok bool) {
	// time.Time.String() may append a monotonic reading ("m=+0.0001"): not part of the value.
	if i := strings.Index(s, " m="); i >= 0 {
		s = s[:i]
	}
	for _, layout := range timeLayouts {
		if t, err := time.Parse(layout, s); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}
