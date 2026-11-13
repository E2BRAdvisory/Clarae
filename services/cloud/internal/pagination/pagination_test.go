package pagination

import (
	"encoding/base64"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"

	"clarae/services/cloud/internal/httpproblem"
	"clarae/shared/syncproto"
)

func TestLimit(t *testing.T) {
	n := func(v int) *int { return &v }
	for _, c := range []struct {
		asked *int
		want  int
	}{{nil, 100}, {n(1), 1}, {n(42), 42}, {n(500), 500}, {n(501), 500}, {n(0), 1}, {n(-3), 1}} {
		if got := Limit(c.asked, DefaultLimit, MaxLimit); got != c.want {
			t.Errorf("Limit(%v) = %d, want %d", c.asked, got, c.want)
		}
	}
}

func TestCursorRoundTrip(t *testing.T) {
	k := Key{List: "groups", K: "Ünïcode, \"quoted\" ~ name", ID: uuid.Must(uuid.NewV7()), N: 7}
	c := Encode(k)
	if strings.ContainsAny(c, "+/=") {
		t.Fatalf("cursor %q is not URL safe", c)
	}
	got, err := Decode("groups", c)
	if err != nil || got == nil || *got != k {
		t.Fatalf("Decode = %+v, %v; want %+v", got, err, k)
	}
	if got, err := Decode("groups", ""); got != nil || err != nil {
		t.Fatalf("empty cursor: %+v, %v", got, err)
	}
}

func TestDecodeRejects(t *testing.T) {
	other := Encode(Key{List: "group-members", K: "a", ID: uuid.New()})
	for name, c := range map[string]string{
		"another list": other,
		"not base64":   "%%%",
		"not JSON":     base64.RawURLEncoding.EncodeToString([]byte("nope")),
		"no list":      base64.RawURLEncoding.EncodeToString([]byte(`{"k":"a"}`)),
		"too long":     strings.Repeat("A", maxCursorLen+1),
	} {
		_, err := Decode("groups", c)
		var p *httpproblem.Error
		if !errors.As(err, &p) || p.Code != syncproto.CodeValidationFailed {
			t.Errorf("%s: want VALIDATION_FAILED, got %v", name, err)
		}
	}
}

func TestTrim(t *testing.T) {
	page, more := Trim([]int{1, 2, 3}, 2)
	if len(page) != 2 || !more {
		t.Fatalf("Trim over the limit = %v, %v", page, more)
	}
	page, more = Trim([]int{1, 2}, 2)
	if len(page) != 2 || more {
		t.Fatalf("Trim at the limit = %v, %v", page, more)
	}
	if FetchLimit(100) != 101 || FetchLimit(10_000) != MaxLimit+1 {
		t.Fatalf("FetchLimit = %d, %d", FetchLimit(100), FetchLimit(10_000))
	}
}
