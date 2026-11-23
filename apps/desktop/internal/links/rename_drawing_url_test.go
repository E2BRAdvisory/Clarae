package links

import "testing"

// Only the schemes of real addresses make a "[[x]]" part of a URL string; the scheme of another
// application is not one, so a link written after it is still a wikilink to rewrite.
func TestInURLStringSchemes(t *testing.T) {
	cases := []struct {
		name string
		data string
		want bool
	}{
		{"https", `{"link":"https://example.com/[[x]]"}`, true},
		{"mailto", `{"link":"mailto:[[x]]"}`, true},
		{"file", `{"link":"file:///a/[[x]]"}`, true},
		{"plain wikilink", `{"link":"[[x]]"}`, false},
		{"unknown scheme", `{"link":"vault://open?file=[[x]]"}`, false},
	}
	for _, c := range cases {
		pos := indexOf(c.data, "[[x]]")
		if got := inURLString([]byte(c.data), pos); got != c.want {
			t.Errorf("%s: inURLString = %v, want %v", c.name, got, c.want)
		}
	}
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
