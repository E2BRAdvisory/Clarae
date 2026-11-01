package sync

import (
	"errors"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestRetryableAndRaceReason(t *testing.T) {
	pg := func(code string) error { return fmt.Errorf("wrapped: %w", &pgconn.PgError{Code: code}) }
	cases := []struct {
		err       error
		retryable bool
		reason    string
	}{
		{pg("40P01"), true, "deadlock"},
		{pg("40001"), true, "serialization"},
		{pg("23505"), false, "unique"},
		{errChargeRace, false, "quota"},
		{errors.New("boom"), false, "other"},
	}
	for _, c := range cases {
		if got := isRetryable(c.err); got != c.retryable {
			t.Errorf("isRetryable(%v) = %v", c.err, got)
		}
		if got := raceReason(c.err); got != c.reason {
			t.Errorf("raceReason(%v) = %q, want %q", c.err, got, c.reason)
		}
	}
}
