package users

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"

	"memobrain/services/cloud/internal/httpproblem"
	"memobrain/shared/syncproto"
)

// An Idempotency-Key longer than the contract allows is refused before any
// database access (the replay is covered by the integration tests).
func TestRegisterDeviceRefusesAnOverlongIdempotencyKey(t *testing.T) {
	_, err := (&Service{}).RegisterDevice(context.Background(), uuid.New(), strings.Repeat("k", MaxIdempotencyKey+1), "Studio", "macos", nil)
	var pe *httpproblem.Error
	if !errors.As(err, &pe) || pe.Code != syncproto.CodeValidationFailed {
		t.Fatalf("err %v, want VALIDATION_FAILED", err)
	}
}
