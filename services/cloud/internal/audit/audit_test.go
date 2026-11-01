package audit

import (
	"context"
	"testing"
)

func TestClientIPContext(t *testing.T) {
	ctx := context.Background()
	if _, ok := ClientIP(ctx); ok {
		t.Fatal("no address was set")
	}
	for in, want := range map[string]string{
		"203.0.113.7":      "203.0.113.7",
		"::ffff:192.0.2.1": "192.0.2.1", // IPv4-mapped IPv6 is stored as IPv4
		"2001:db8::1":      "2001:db8::1",
	} {
		got, ok := ClientIP(WithClientIP(ctx, in))
		if !ok || got.String() != want {
			t.Errorf("WithClientIP(%q) = %v %v, want %s", in, got, ok, want)
		}
	}
	for _, bad := range []string{"", "not-an-ip", "203.0.113.7:443"} {
		if _, ok := ClientIP(WithClientIP(ctx, bad)); ok {
			t.Errorf("%q must not be recorded", bad)
		}
	}
	if _, ok := ClientIP(WithoutClientIP(WithClientIP(ctx, "203.0.113.7"))); ok {
		t.Error("WithoutClientIP must drop the address")
	}
}
