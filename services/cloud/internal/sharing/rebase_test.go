package sharing

import "testing"

// A folder rename carries the shares whose prefix has the same path key as the
// renamed folder or lies below it (pathrules.Key, not lower()), and rebuilds
// their prefix by segments, whatever the byte length of the folded match.
func TestRebasePrefixMatchesByPathKey(t *testing.T) {
	cases := []struct {
		prefix, from, to string
		want             string
		ok               bool
	}{
		{"Team", "Team", "Team-2025", "Team-2025", true},
		{"Team/Sub/Deep", "Team", "Archive/Team", "Archive/Team/Sub/Deep", true},
		{"team/sub", "Team", "T", "T/sub", true},
		// ß folds to ss: lower() would not see these as the same folder.
		{"STRASSE", "Straße", "Archivio/Straße", "Archivio/Straße", true},
		{"STRASSE/Unten", "Straße", "Archivio/Straße", "Archivio/Straße/Unten", true},
		{"Straße/x", "STRASSE", "Y", "Y/x", true},
		// Final and medial sigma fold alike.
		{"ΟΔΟΣ/a", "οδος", "Δρόμος", "Δρόμος/a", true},
		// NFD and NFC are the same key.
		{"Café/menu", "Café", "Bar", "Bar/menu", true},
		// Not the same folder: a sibling sharing the first letters, a parent, elsewhere.
		{"Team-old", "Team", "X", "", false},
		{"Teamwork/a", "Team", "X", "", false},
		{"Team", "Team/Sub", "X", "", false},
		{"Other/Team", "Team", "X", "", false},
		{"Team", "", "X", "", false},
	}
	for _, c := range cases {
		got, ok := rebasePrefix(c.prefix, c.from, c.to)
		if ok != c.ok || got != c.want {
			t.Errorf("rebasePrefix(%q, %q, %q) = %q, %v; want %q, %v", c.prefix, c.from, c.to, got, ok, c.want, c.ok)
		}
	}
}
