package sqlitejs

import (
	"reflect"
	"testing"
)

func TestParseDSN(t *testing.T) {
	tests := []struct {
		dsn     string
		path    string
		pragmas []string
		wantErr bool
	}{
		{dsn: "file:/v/.memobrain/index.db?_pragma=journal_mode%28WAL%29&_pragma=busy_timeout%285000%29", path: "/v/.memobrain/index.db", pragmas: []string{"journal_mode(WAL)", "busy_timeout(5000)"}},
		{dsn: "file:/a/b.db", path: "/a/b.db"},
		{dsn: "/plain/path.db", path: "/plain/path.db"},
		{dsn: "file:?_pragma=x", wantErr: true},
		// The escaped URI internal/store builds: '#', '?', '%', spaces and UTF-8 are percent-encoded.
		{dsn: "file:///v/My%20%23notes%3F%25/%C3%A8/index.db?_pragma=foreign_keys%28ON%29", path: "/v/My #notes?%/è/index.db", pragmas: []string{"foreign_keys(ON)"}},
		{dsn: "file://localhost/v/a.db", path: "/v/a.db"},
		{dsn: "file:///C:/Users/a%20b/v.db", path: "/C:/Users/a b/v.db"},
		{dsn: "file:rel.db?_pragma=x", path: "rel.db", pragmas: []string{"x"}},
		{dsn: "file://host/v/a.db", wantErr: true},
		{dsn: "file:///v/bad%zz.db", wantErr: true},
	}
	for _, tt := range tests {
		path, pragmas, err := parseDSN(tt.dsn)
		if (err != nil) != tt.wantErr {
			t.Fatalf("%q: err = %v", tt.dsn, err)
		}
		if path != tt.path || !reflect.DeepEqual(pragmas, tt.pragmas) {
			t.Errorf("%q: got (%q, %v), want (%q, %v)", tt.dsn, path, pragmas, tt.path, tt.pragmas)
		}
	}
}
