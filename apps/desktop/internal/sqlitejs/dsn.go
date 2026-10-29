package sqlitejs

import (
	"fmt"
	"net/url"
	"strings"
)

// parseDSN splits a "file:<path>?_pragma=a&_pragma=b" data source name (the form internal/store
// builds for modernc.org/sqlite) into the database path and its PRAGMA statements.
func parseDSN(dsn string) (path string, pragmas []string, err error) {
	rest := strings.TrimPrefix(dsn, "file:")
	path, query, _ := strings.Cut(rest, "?")
	if path == "" {
		return "", nil, fmt.Errorf("sqlitejs: empty database path in %q", dsn)
	}
	if query == "" {
		return path, nil, nil
	}
	values, err := url.ParseQuery(query)
	if err != nil {
		return "", nil, fmt.Errorf("sqlitejs: bad DSN query: %w", err)
	}
	for _, p := range values["_pragma"] {
		if p = strings.TrimSpace(p); p != "" {
			pragmas = append(pragmas, p)
		}
	}
	return path, pragmas, nil
}
