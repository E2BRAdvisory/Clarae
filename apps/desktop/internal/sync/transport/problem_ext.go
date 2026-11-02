package transport

import (
	"encoding/json"
	"errors"
	"math"

	"memobrain/shared/syncproto"
)

// ExtraInt returns the integer extension member key of the problem in err
// (Problem.Extra, decoded from JSON as a float64). ok is false when err is not
// a problem or the member is missing or not an integer.
func ExtraInt(err error, key string) (n int64, ok bool) {
	var pe *ProblemError
	if !errors.As(err, &pe) {
		return 0, false
	}
	switch v := pe.Problem.Extra[key].(type) {
	case float64:
		if v != math.Trunc(v) || math.IsInf(v, 0) {
			return 0, false
		}
		return int64(v), true
	case int64:
		return v, true
	case int:
		return int64(v), true
	case json.Number:
		n, err := v.Int64()
		return n, err == nil
	}
	return 0, false
}

// ServerBehind reports whether err is the 410 CURSOR_EXPIRED of a cursor that
// is ahead of the server (extension member last_seq): the vault database was
// restored to an earlier point in time and lost changes this device has
// (ADR-0022, ADR-0046). A cursor older than the changelog window carries
// compaction_seq instead, and is not this case.
func ServerBehind(err error) bool {
	if !IsCode(err, syncproto.CodeCursorExpired) {
		return false
	}
	_, ok := ExtraInt(err, "last_seq")
	return ok
}
