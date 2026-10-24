package blobs

import (
	"errors"
	"testing"
)

func TestParseRange(t *testing.T) {
	cases := []struct {
		header string
		size   int64
		want   Range
		ok     bool
		err    error
	}{
		{"", 10, Range{}, false, nil},
		{"bytes=0-3", 10, Range{0, 3}, true, nil},
		{"bytes=4-", 10, Range{4, 9}, true, nil},
		{"bytes=-3", 10, Range{7, 9}, true, nil},
		{"bytes=-50", 10, Range{0, 9}, true, nil},
		{"bytes=5-99", 10, Range{5, 9}, true, nil},
		{"bytes=0-1,4-5", 10, Range{}, false, nil}, // multiple ranges: whole blob
		{"items=0-1", 10, Range{}, false, nil},
		{"bytes=10-", 10, Range{}, false, ErrRange},
		{"bytes=7-3", 10, Range{}, false, ErrRange},
		{"bytes=x-3", 10, Range{}, false, ErrRange},
		{"bytes=-0", 10, Range{}, false, ErrRange},
	}
	for _, c := range cases {
		got, ok, err := ParseRange(c.header, c.size)
		if !errors.Is(err, c.err) || ok != c.ok || (ok && got != c.want) {
			t.Errorf("%q: got %v %v %v, want %v %v %v", c.header, got, ok, err, c.want, c.ok, c.err)
		}
	}
}

func TestIsHash(t *testing.T) {
	good := "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
	if !IsHash(good) {
		t.Error("valid hash rejected")
	}
	for _, bad := range []string{"", good[:63], good + "0", "G" + good[1:], "9F86D081884C7D659A2FEAA0C55AD015A3BF4F1B2B0B822CD15D6C15B0F00A08"} {
		if IsHash(bad) {
			t.Errorf("%q accepted", bad)
		}
	}
}
