package sqlitejs

import (
	"fmt"
	"net/url"
	"strings"
)

// parseDSN splits a data source name into the database path and its PRAGMA statements. internal/store
// builds an escaped URI, "file:///<path>?_pragma=a&_pragma=b", whose path is decoded as SQLite
// does; a DSN without the "file:" prefix is a plain path, up to an optional "?query".
func parseDSN(dsn string) (path string, pragmas []string, err error) {
	var query string
	if strings.HasPrefix(dsn, "file:") {
		u, err := url.Parse(dsn)
		if err != nil {
			return "", nil, fmt.Errorf("sqlitejs: bad DSN: %w", err)
		}
		if u.Host != "" && u.Host != "localhost" {
			return "", nil, fmt.Errorf("sqlitejs: bad DSN authority %q", u.Host)
		}
		path, query = u.Path, u.RawQuery
		if u.Opaque != "" { // "file:relative.db"
			if path, err = url.PathUnescape(u.Opaque); err != nil {
				return "", nil, fmt.Errorf("sqlitejs: bad DSN path: %w", err)
			}
		}
	} else {
		path, query, _ = strings.Cut(dsn, "?")
	}
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
