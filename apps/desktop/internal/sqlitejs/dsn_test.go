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
