package store

import (
	"net/url"
	"testing"
)

func TestFileURI(t *testing.T) {
	q := url.Values{"_pragma": []string{"foreign_keys(ON)"}}
	tests := []struct{ path, want string }{
		{"/v/.clarae/index.db", "file:///v/.clarae/index.db?_pragma=foreign_keys%28ON%29"},
		{"/Users/x/Progetti #1/.clarae/sync.db", "file:///Users/x/Progetti%20%231/.clarae/sync.db?_pragma=foreign_keys%28ON%29"},
		{"/v/a?b/100%25/è.db", "file:///v/a%3Fb/100%2525/%C3%A8.db?_pragma=foreign_keys%28ON%29"},
	}
	for _, tt := range tests {
		got, err := fileURI(tt.path, q)
		if err != nil {
			t.Fatalf("%q: %v", tt.path, err)
		}
		if got != tt.want {
			t.Errorf("%q: got %q, want %q", tt.path, got, tt.want)
		}
	}
}

// On Windows filepath.ToSlash turns "C:\v\x.db" into "C:/v/x.db" and the UNC path
// "\\srv\share\x.db" into "//srv/share/x.db": SQLite reads an empty authority, then the path.
func TestSlashURIDriveLetter(t *testing.T) {
	q := url.Values{"_pragma": []string{"foreign_keys(ON)"}}
	tests := []struct{ path, want string }{
		{"C:/v/a #1/x.db", "file:///C:/v/a%20%231/x.db?_pragma=foreign_keys%28ON%29"},
		{"//srv/share/a #1/x.db", "file:////srv/share/a%20%231/x.db?_pragma=foreign_keys%28ON%29"},
	}
	for _, tt := range tests {
		if got := slashURI(tt.path, q); got != tt.want {
			t.Errorf("%q: got %q, want %q", tt.path, got, tt.want)
		}
	}
}

func TestLegacyURIPath(t *testing.T) {
	tests := []struct{ path, want string }{
		{"/v/.clarae/index.db", "/v/.clarae/index.db"},
		{"/Users/x/Progetti #1/.clarae/index.db", "/Users/x/Progetti "},
		{"/Users/x/a?b/.clarae/sync.db", "/Users/x/a"},
		{"/v/100%25 done/x.db", "/v/100% done/x.db"},
		{"/v/%e2%82%ac/x.db", "/v/€/x.db"},
		{"/v/100%/x%2/y%zz.db", "/v/100%/x%2/y%zz.db"}, // not an escape: kept verbatim
		{"/v/a%00b/x.db", "/v/a"},
		{"/v/è #/x.db", "/v/è "},
		{"#x", ""},
	}
	for _, tt := range tests {
		if got := legacyURIPath(tt.path); got != tt.want {
			t.Errorf("%q: got %q, want %q", tt.path, got, tt.want)
		}
	}
}
