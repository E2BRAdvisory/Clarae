package admin

import (
	"errors"
	"math"
	"testing"

	"memobrain/services/cloud/internal/api"
	"memobrain/services/cloud/internal/httpproblem"
	"memobrain/shared/syncproto"
)

func TestProfileInputCarriesTheExpectedVersion(t *testing.T) {
	body := func(v *int) *api.ConfigProfileInput {
		return &api.ConfigProfileInput{Name: "P", Config: map[string]any{}, ExpectedVersion: v}
	}
	in, err := profileInput(body(nil))
	if err != nil || in.ExpectedVersion != nil {
		t.Fatalf("no expected version: %+v, %v", in, err)
	}
	three := 3
	in, err = profileInput(body(&three))
	if err != nil || in.ExpectedVersion == nil || *in.ExpectedVersion != 3 {
		t.Fatalf("expected version 3: %+v, %v", in, err)
	}
	for _, v := range []int{0, -1, math.MaxInt32 + 1} {
		_, err := profileInput(body(&v))
		var p *httpproblem.Error
		if !errors.As(err, &p) || p.Code != syncproto.CodeValidationFailed {
			t.Errorf("expected_version %d: %v, want VALIDATION_FAILED", v, err)
		}
	}
}
