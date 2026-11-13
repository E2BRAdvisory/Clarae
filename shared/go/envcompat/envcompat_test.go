package envcompat

import "testing"

func TestLookup(t *testing.T) {
	for _, tc := range []struct {
		name            string
		current, legacy string
		want            string
		deprecated      bool
	}{
		{name: "unset"},
		{name: "current only", current: "new", want: "new"},
		{name: "legacy only", legacy: "old", want: "old", deprecated: true},
		{name: "current wins", current: "new", legacy: "old", want: "new"},
		{name: "empty current falls back", current: "", legacy: "old", want: "old", deprecated: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(Prefix+"ENVCOMPAT_TEST", tc.current)
			t.Setenv(LegacyPrefix+"ENVCOMPAT_TEST", tc.legacy)
			got, deprecated := Lookup("ENVCOMPAT_TEST")
			if got != tc.want || deprecated != tc.deprecated {
				t.Fatalf("Lookup = %q, %v; want %q, %v", got, deprecated, tc.want, tc.deprecated)
			}
			if Get("ENVCOMPAT_TEST") != tc.want {
				t.Fatalf("Get = %q, want %q", Get("ENVCOMPAT_TEST"), tc.want)
			}
		})
	}
}
