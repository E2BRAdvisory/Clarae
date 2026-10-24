package admin

import "testing"

func TestCSVSafeNeutralisesFormulas(t *testing.T) {
	for in, want := range map[string]string{
		"":            "",
		"user.create": "user.create",
		"=SUM(A1)":    "'=SUM(A1)",
		"+1":          "'+1",
		"-2":          "'-2",
		"@cmd":        "'@cmd",
		"\tx":         "'\tx",
		"a=b":         "a=b",
		`{"a":"=1"}`:  `{"a":"=1"}`,
	} {
		if got := csvSafe(in); got != want {
			t.Errorf("csvSafe(%q) = %q, want %q", in, got, want)
		}
	}
}
