package sqlitejs

import (
	"testing"
	"time"
)

func TestParseTime(t *testing.T) {
	want := time.Date(2026, 10, 29, 17, 30, 5, 0, time.UTC)
	for _, in := range []string{
		"2026-10-29 17:30:05",
		"2026-10-29T17:30:05",
		"2026-10-29T17:30:05Z",
		"2026-10-29 17:30:05+00:00",
		"2026-10-29 17:30:05 +0000 UTC",
		"2026-10-29 19:30:05+02:00",
		"2026-10-29 17:30:05 +0000 UTC m=+1.5",
	} {
		got, ok := parseTime(in)
		if !ok || !got.Equal(want) {
			t.Errorf("parseTime(%q) = %v, %v; want %v", in, got, ok, want)
		}
	}
	if got, ok := parseTime("2026-10-29"); !ok || got.Day() != 29 {
		t.Errorf("a plain date: %v %v", got, ok)
	}
	if _, ok := parseTime("not a date"); ok {
		t.Error("garbage parsed as a date")
	}
	for _, decl := range []string{"timestamp", "DATETIME", "Date"} {
		if !isTimeType(decl) {
			t.Errorf("%q should be a time type", decl)
		}
	}
	if isTimeType("TEXT") || isTimeType("") {
		t.Error("TEXT is not a time type")
	}
}
