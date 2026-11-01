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

func TestCSVSafeRowCoversEveryColumn(t *testing.T) {
	for _, name := range []string{"=cmd|' /C calc'!A0", "+1+1", "-1-1", "@SUM(A1)", "\tname", "\rname"} {
		row := csvSafeRow("1", "2026-01-01T00:00:00Z", "0190...", name, "user.create", "user", name, `{"username":"x"}`, "203.0.113.7")
		if row[3] != "'"+name || row[6] != "'"+name {
			t.Errorf("actor/target %q not neutralised: %q", name, row)
		}
		if row[0] != "1" || row[4] != "user.create" || row[8] != "203.0.113.7" {
			t.Errorf("safe cells changed: %q", row)
		}
	}
}
