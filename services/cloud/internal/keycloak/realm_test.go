package keycloak

import (
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"testing"
)

const prodRealm = "../../../../deploy/keycloak-prod/realm-memobrain.json"

// realmClient loads one client of a realm export as a generic JSON object.
func realmClient(t *testing.T, path, clientID string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var realm struct {
		Clients []map[string]any `json:"clients"`
	}
	if err := json.Unmarshal(raw, &realm); err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	for _, c := range realm.Clients {
		if c["clientId"] == clientID {
			return c
		}
	}
	t.Fatalf("%s: client %q not found", path, clientID)
	return nil
}

// stringsOf returns every string value in v, with the JSON path that holds it.
func stringsOf(path string, v any, out map[string]string) {
	switch x := v.(type) {
	case string:
		out[path] = x
	case []any:
		for i, e := range x {
			stringsOf(path+"["+strconv.Itoa(i)+"]", e, out)
		}
	case map[string]any:
		for k, e := range x {
			stringsOf(path+"."+k, e, out)
		}
	}
}

func stringList(t *testing.T, c map[string]any, key string) []string {
	t.Helper()
	var out []string
	l, _ := c[key].([]any)
	for _, e := range l {
		s, ok := e.(string)
		if !ok {
			t.Fatalf("%s: non-string entry %v", key, e)
		}
		out = append(out, s)
	}
	return out
}

// uriAllowed reports whether Keycloak would accept uri against a list of valid redirect URIs:
// an exact match, or a prefix match for an entry ending in "*".
func uriAllowed(uri string, patterns []string) bool {
	for _, p := range patterns {
		if p == uri || (strings.HasSuffix(p, "*") && strings.HasPrefix(uri, strings.TrimSuffix(p, "*"))) {
			return true
		}
	}
	return false
}

// The production realm (deploy/keycloak-prod, imported by deploy/compose) takes the Web UI
// origin from WEB_UI_ORIGIN, which Keycloak substitutes at import time. A development origin
// left in memobrain-web breaks production: with a post-logout redirect URI that does not match
// the public origin Keycloak refuses the Web UI logout and the SSO session stays open.
func TestProductionRealmWebClientUsesPublicOrigin(t *testing.T) {
	c := realmClient(t, prodRealm, "memobrain-web")

	values := map[string]string{}
	stringsOf("memobrain-web", c, values)
	for path, v := range values {
		if l := strings.ToLower(v); strings.Contains(l, "localhost") || strings.Contains(l, "127.0.0.1") {
			t.Errorf("%s = %q: development origin in the production realm, use ${WEB_UI_ORIGIN}", path, v)
		}
	}

	if got := stringList(t, c, "redirectUris"); !uriAllowed("${WEB_UI_ORIGIN}/auth/callback", got) {
		t.Errorf("redirectUris %q do not cover ${WEB_UI_ORIGIN}/auth/callback", got)
	}
	if got := stringList(t, c, "webOrigins"); len(got) != 1 || got[0] != "${WEB_UI_ORIGIN}" {
		t.Errorf("webOrigins = %q, want [${WEB_UI_ORIGIN}]", got)
	}

	// web/src/auth/oidc.ts signs out with post_logout_redirect_uri = window.location.origin + "/".
	attrs, _ := c["attributes"].(map[string]any)
	post, _ := attrs["post.logout.redirect.uris"].(string)
	var allowed []string
	for _, p := range strings.Split(post, "##") {
		if p == "+" { // "+" reuses the valid redirect URIs
			allowed = append(allowed, stringList(t, c, "redirectUris")...)
			continue
		}
		allowed = append(allowed, p)
	}
	if !uriAllowed("${WEB_UI_ORIGIN}/", allowed) {
		t.Errorf("post.logout.redirect.uris = %q does not cover ${WEB_UI_ORIGIN}/: Keycloak would refuse the Web UI logout", post)
	}
}

func TestURIAllowed(t *testing.T) {
	for _, tc := range []struct {
		uri      string
		patterns []string
		want     bool
	}{
		{"https://h/", []string{"https://h/*"}, true},
		{"https://h/", []string{"https://h/"}, true},
		{"https://h/", []string{"http://localhost:5174/*", "http://localhost:18081/*"}, false},
		{"https://h/", []string{"https://h/auth/*"}, false},
		{"https://h/", nil, false},
	} {
		if got := uriAllowed(tc.uri, tc.patterns); got != tc.want {
			t.Errorf("uriAllowed(%q, %q) = %v, want %v", tc.uri, tc.patterns, got, tc.want)
		}
	}
}
