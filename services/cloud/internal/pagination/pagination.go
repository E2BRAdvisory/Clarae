// Package pagination holds the page size and the keyset cursors of the list
// operations (api/openapi.yaml, "Pagination").
//
// A cursor is the position of the last row of a page: its sort key and id
// (or a number, for lists ordered by one), tagged with the list it belongs
// to. It is base64url JSON, opaque to clients and never trusted for anything
// but a position: every page runs the full authorization of its query, so a
// cursor forged or taken from someone else only moves where the list starts.
package pagination

import (
	"encoding/base64"
	"encoding/json"

	"github.com/google/uuid"

	"clarae/services/cloud/internal/httpproblem"
	"clarae/shared/syncproto"
)

// The page size of a list operation unless its contract says otherwise.
const (
	DefaultLimit = 100
	MaxLimit     = 500
)

// maxCursorLen bounds what Decode reads (the contract caps the parameter at 2048: a
// cursor carries a name of up to a few hundred UTF-8 characters, base64 encoded).
const maxCursorLen = 2048

// Limit returns the page size asked for: def when absent, at most maxLimit and at least 1.
func Limit(asked *int, def, maxLimit int) int {
	if asked == nil {
		return def
	}
	return min(max(*asked, 1), maxLimit)
}

// Key is a keyset position: the list it belongs to and the sort key of the
// last row of the page (K and ID, or N for a list ordered by a number).
type Key struct {
	List string    `json:"l"`
	K    string    `json:"k,omitempty"`
	ID   uuid.UUID `json:"i,omitzero"`
	N    int64     `json:"n,omitempty"`
}

// Encode renders a position as a cursor.
func Encode(k Key) string {
	b, _ := json.Marshal(k) // a struct of strings, a UUID and an int: cannot fail
	return base64.RawURLEncoding.EncodeToString(b)
}

// Decode reads a cursor of list: nil for "" (the first page), a
// VALIDATION_FAILED problem for anything that is not a cursor of that list.
func Decode(list, cursor string) (*Key, error) {
	if cursor == "" {
		return nil, nil
	}
	if len(cursor) > maxCursorLen {
		return nil, invalid()
	}
	b, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return nil, invalid()
	}
	var k Key
	if err := json.Unmarshal(b, &k); err != nil || k.List != list {
		return nil, invalid()
	}
	return &k, nil
}

func invalid() error { return httpproblem.Errorf(syncproto.CodeValidationFailed, "invalid cursor") }

// Trim cuts the limit+1 rows a page query fetched to the page: more reports
// whether a row was left out, so the page has a next one.
func Trim[T any](rows []T, limit int) (page []T, more bool) {
	if len(rows) > limit {
		return rows[:limit], true
	}
	return rows, false
}

// Cursor is the `next_cursor` of a page ending at last.
func Cursor(last Key) *string {
	c := Encode(last)
	return &c
}

// FetchLimit is the LIMIT of a page query: one row more than the page, to
// know whether another page follows.
func FetchLimit(limit int) int32 {
	return int32(min(limit, MaxLimit) + 1) // #nosec G115 -- bounded by MaxLimit
}
