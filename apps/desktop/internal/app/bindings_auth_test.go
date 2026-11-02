package app

import (
	"runtime"
	"strings"
	"testing"

	"memobrain/apps/desktop/internal/auth"
)

// A server typed with plain http on another computer is refused before any
// request, with a code the frontend can branch on; one without a scheme
// means https.
func TestLoginRefusesPlainHTTPToAnotherComputer(t *testing.T) {
	if runtime.GOOS == "js" {
		t.Skip("the browser core signs in through the page, whose origin decides")
	}
	a, _, _ := newTestApp(t)
	x := NewAuthAPI(a)
	for _, u := range []string{"http://cloud.example.com", " HTTP://cloud.example.com ", "http://localhost@cloud.example.com"} {
		st, err := x.Login(u)
		if err == nil || !strings.HasPrefix(err.Error(), ErrCodeInsecureURL+": ") {
			t.Fatalf("%q: %v", u, err)
		}
		if st.Status != auth.StatusSignedOut && st.Status != "" {
			t.Fatalf("%q: state %+v", u, st)
		}
	}
	if !hasScheme("HTTPS://x", "https://") || hasScheme("cloud.example.com", "http://") {
		t.Fatal("hasScheme")
	}
}
