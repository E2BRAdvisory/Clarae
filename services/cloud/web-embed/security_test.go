package webembed

import (
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"regexp"
	"strings"
	"testing"
)

// These tests run against the build that is really embedded in the binary
// (dist/, produced by `task web-build`): the CSP only protects if the page it
// protects has no inline code and every subresource is pinned by SRI.

var (
	tagRe       = regexp.MustCompile(`(?is)<(script|link|style|iframe|object|embed|img|form|base|meta)\b([^>]*)>`)
	attrRe      = regexp.MustCompile(`(?is)([a-zA-Z:-]+)\s*=\s*"([^"]*)"`)
	bareAttrRe  = regexp.MustCompile(`(?is)\s(crossorigin)(\s|/|$)`)
	inlineEvent = regexp.MustCompile(`(?i)\son[a-z]+\s*=`)
)

func indexHTML(t *testing.T) string {
	t.Helper()
	b, err := fs.ReadFile(Dist(), "index.html")
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func attrs(s string) map[string]string {
	m := map[string]string{}
	for _, a := range attrRe.FindAllStringSubmatch(s, -1) {
		m[strings.ToLower(a[1])] = a[2]
	}
	if bareAttrRe.MatchString(" " + s + " ") {
		if _, ok := m["crossorigin"]; !ok {
			m["crossorigin"] = ""
		}
	}
	return m
}

func TestBuiltIndexPinsEverySubresourceWithSRI(t *testing.T) {
	checkPagePinsEverySubresource(t, "index.html")
}

// The vault workbench page is held to the same rules: no inline code, nothing from another origin, and
// every script and style sheet pinned by SRI to the bytes that are really embedded.
func TestBuiltWorkbenchPinsEverySubresourceWithSRI(t *testing.T) {
	if _, err := fs.Stat(Dist(), "workbench.html"); err != nil {
		if os.Getenv("CLARAE_REQUIRE_WEB_BUILD") != "" {
			t.Fatal("workbench.html is not embedded: is dist/ built (task web-build)?")
		}
		t.Skip("dist/ holds only the placeholder index (run task web-build)")
	}
	checkPagePinsEverySubresource(t, "workbench.html")
}

func checkPagePinsEverySubresource(t *testing.T, page string) {
	t.Helper()
	b, err := fs.ReadFile(Dist(), page)
	if err != nil {
		t.Fatal(err)
	}
	html := string(b)
	root := Dist()
	pinned, importMaps := 0, 0
	for _, m := range tagRe.FindAllStringSubmatch(html, -1) {
		name, a := strings.ToLower(m[1]), attrs(m[2])
		switch name {
		case "script":
			src := a["src"]
			if src == "" && strings.EqualFold(a["type"], "importmap") && page == "workbench.html" {
				importMaps++
				continue // checked below with its text
			}
			if src == "" {
				t.Errorf("inline <script> in %s: %q", page, m[0])
				continue
			}
			checkPinned(t, root, name, src, a)
			pinned++
		case "link":
			rel := strings.ToLower(a["rel"])
			if rel == "icon" || rel == "apple-touch-icon" || rel == "mask-icon" || rel == "manifest" {
				checkLocal(t, a["href"])
				continue
			}
			if rel != "stylesheet" && rel != "modulepreload" {
				t.Errorf("unexpected <link rel=%q>: %q", rel, m[0])
				continue
			}
			checkPinned(t, root, name, a["href"], a)
			pinned++
		case "style":
			t.Errorf("inline <style> in %s", page)
		case "iframe", "object", "embed", "form", "base":
			t.Errorf("unexpected <%s> in %s", name, page)
		case "img":
			checkLocal(t, a["src"])
		}
	}
	if pinned == 0 {
		t.Fatal("index.html references no script or stylesheet: is dist/ built?")
	}
	if importMaps > 0 {
		checkImportMap(t, root, b)
	}
	if inlineEvent.MatchString(html) {
		t.Errorf("inline event handler attribute in %s", page)
	}
	if regexp.MustCompile(`(?i)\sstyle\s*=`).MatchString(html) {
		t.Errorf("inline style attribute in %s", page)
	}
	if strings.Contains(strings.ToLower(html), "javascript:") {
		t.Errorf("javascript: URL in %s", page)
	}
}

func checkLocal(t *testing.T, ref string) {
	t.Helper()
	if ref == "" {
		return
	}
	u, err := url.Parse(ref)
	if err != nil || u.Scheme != "" || u.Host != "" || strings.HasPrefix(ref, "//") {
		t.Errorf("external reference %q: the page must load nothing from other origins", ref)
	}
}

func checkPinned(t *testing.T, root fs.FS, tag, ref string, a map[string]string) {
	t.Helper()
	checkLocal(t, ref)
	integrity := a["integrity"]
	if !strings.HasPrefix(integrity, "sha384-") {
		t.Errorf("<%s %s> has no sha384 integrity (%q)", tag, ref, integrity)
		return
	}
	if _, ok := a["crossorigin"]; !ok {
		t.Errorf("<%s %s> has integrity but no crossorigin attribute", tag, ref)
	}
	data, err := fs.ReadFile(root, strings.TrimPrefix(ref, "/"))
	if err != nil {
		// The tracked dist/ holds only the placeholder index; CI builds the real SPA
		// (task web-build) and sets CLARAE_REQUIRE_WEB_BUILD=1 so a missing file is an error.
		if os.Getenv("CLARAE_REQUIRE_WEB_BUILD") != "" {
			t.Errorf("<%s %s>: file is not embedded: %v", tag, ref, err)
		}
		return
	}
	sum := sha512.Sum384(data)
	if want := "sha384-" + base64.StdEncoding.EncodeToString(sum[:]); integrity != want {
		t.Errorf("<%s %s>: integrity %s does not match the embedded file (%s): stale build?", tag, ref, integrity, want)
	}
}

func TestEmbeddedStylesheetsLoadNothingExternal(t *testing.T) {
	ext := regexp.MustCompile(`(?i)(@import\s+(url\()?["']?(https?:)?//|url\(\s*["']?(https?:)?//)`)
	err := fs.WalkDir(Dist(), ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".css") {
			return err
		}
		b, err := fs.ReadFile(Dist(), p)
		if err != nil {
			return err
		}
		if ext.Match(b) {
			t.Errorf("%s references an external resource", p)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

// csp parses a policy into directive -> sources.
func csp(v string) map[string][]string {
	out := map[string][]string{}
	for _, d := range strings.Split(v, ";") {
		f := strings.Fields(d)
		if len(f) > 0 {
			out[f[0]] = f[1:]
		}
	}
	return out
}

func TestCSPIsStrict(t *testing.T) {
	p := csp(CSP("https://id.example.com/realms/clarae"))
	has := func(dir string, want ...string) {
		t.Helper()
		got := strings.Join(p[dir], " ")
		if got != strings.Join(want, " ") {
			t.Errorf("%s = %q, want %q", dir, got, strings.Join(want, " "))
		}
	}
	has("default-src", "'self'")
	has("script-src", "'self'", "'wasm-unsafe-eval'")
	has("style-src", "'self'")
	has("connect-src", "'self'", "https://id.example.com")
	has("frame-ancestors", "'none'")
	has("base-uri", "'none'")
	has("object-src", "'none'")
	has("form-action", "'self'")
	for dir, srcs := range p {
		for _, s := range srcs {
			if s == "*" || s == "'unsafe-inline'" || s == "'unsafe-eval'" || strings.HasPrefix(s, "http:") {
				t.Errorf("%s allows %s", dir, s)
			}
		}
	}
	if _, ok := p["script-src"]; !ok {
		t.Error("script-src missing")
	}
	// Only the workbench starts a worker from a blob: (its SRI-checked core): the console never does.
	if _, ok := p["worker-src"]; ok || strings.Contains(CSP("https://id.example.com"), "blob:") {
		t.Errorf("the console policy must not allow blob: workers: %v", p)
	}
}

// Every class of response (page, asset, 404, 405) carries the full header set.
func TestSecurityHeadersOnEveryResponseClass(t *testing.T) {
	h := Handler(Options{Issuer: "https://id.example.com/realms/clarae"})
	for _, c := range []struct {
		method, path string
		code         int
	}{
		{http.MethodGet, "/", http.StatusOK},
		{http.MethodGet, "/vaults", http.StatusOK},
		{http.MethodGet, "/missing.js", http.StatusNotFound},
		{http.MethodGet, "/api/v1/x", http.StatusNotFound},
		{http.MethodPost, "/", http.StatusMethodNotAllowed},
	} {
		rec := get(h, c.method, c.path)
		if rec.Code != c.code {
			t.Errorf("%s %s: code %d, want %d", c.method, c.path, rec.Code, c.code)
		}
		hd := rec.Header()
		for k, want := range map[string]string{
			"X-Content-Type-Options":     "nosniff",
			"Referrer-Policy":            "no-referrer",
			"X-Frame-Options":            "DENY",
			"Cross-Origin-Opener-Policy": "same-origin",
		} {
			if hd.Get(k) != want {
				t.Errorf("%s %s: %s = %q, want %q", c.method, c.path, k, hd.Get(k), want)
			}
		}
		if hd.Get("Content-Security-Policy") == "" || !strings.Contains(hd.Get("Permissions-Policy"), "camera=()") {
			t.Errorf("%s %s: CSP or Permissions-Policy missing", c.method, c.path)
		}
	}
	// Embedded assets listed by the index are served with their immutable caching.
	for _, m := range regexp.MustCompile(`(?:src|href)="(/assets/[^"]+)"`).FindAllStringSubmatch(indexHTML(t), -1) {
		if _, err := fs.Stat(Dist(), strings.TrimPrefix(m[1], "/")); err != nil {
			if os.Getenv("CLARAE_REQUIRE_WEB_BUILD") != "" {
				t.Errorf("%s is not embedded", m[1])
			}
			continue
		}
		rec := get(h, http.MethodGet, m[1])
		if rec.Code != http.StatusOK || !strings.Contains(rec.Header().Get("Cache-Control"), "immutable") {
			t.Errorf("%s: %d %q", m[1], rec.Code, rec.Header().Get("Cache-Control"))
		}
	}
}

// checkImportMap verifies the workbench's import map: each entry pins an embedded chunk to its real
// bytes, and the policy the handler serves allows that exact text and nothing else inline.
func checkImportMap(t *testing.T, root fs.FS, page []byte) {
	t.Helper()
	maps := importMapRe.FindAllSubmatch(page, -1)
	if len(maps) != 1 {
		t.Fatalf("workbench.html has %d import maps, want 1", len(maps))
	}
	var m struct {
		Imports   map[string]string `json:"imports"`
		Scopes    map[string]any    `json:"scopes"`
		Integrity map[string]string `json:"integrity"`
	}
	if err := json.Unmarshal(maps[0][1], &m); err != nil {
		t.Fatalf("import map: %v", err)
	}
	if len(m.Imports) > 0 || len(m.Scopes) > 0 {
		t.Errorf("the import map must only pin chunks, it remaps specifiers: %v %v", m.Imports, m.Scopes)
	}
	if len(m.Integrity) == 0 {
		t.Error("the import map pins no chunk")
	}
	for ref, integrity := range m.Integrity {
		checkPinned(t, root, "importmap", ref, map[string]string{"integrity": integrity, "crossorigin": ""})
	}
	rec := httptest.NewRecorder()
	Handler(Options{}).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/vaults/x/open", nil))
	policy := csp(rec.Header().Get("Content-Security-Policy"))
	want := ImportMapHashes(page)
	if got := strings.Join(policy["script-src"], " "); got != "'self' 'wasm-unsafe-eval' "+strings.Join(want, " ") {
		t.Errorf("workbench script-src = %q, want the import map's hash %v", got, want)
	}
}

// Every script of the embedded build must be pinned by SRI, directly or through a chain that starts at
// a page: a page's tags and the workbench import map pin files; a pinned file may carry the integrity
// of another (the core and layout workers, the pdf.js worker, Excalidraw's script), which pins that one.
// A script outside every chain would run unverified (ADR-0029, Esito).
func TestEveryEmbeddedScriptIsPinned(t *testing.T) {
	root := Dist()
	if _, err := fs.Stat(root, "workbench.html"); err != nil {
		if os.Getenv("CLARAE_REQUIRE_WEB_BUILD") != "" {
			t.Fatal("workbench.html is not embedded: is dist/ built (task web-build)?")
		}
		t.Skip("dist/ holds only the placeholder index (run task web-build)")
	}
	// sha384 integrity -> every file with that content: byte-identical files (the empty modules esbuild
	// makes for an unused import) share one hash, and the integrity of one pins them all.
	byHash := map[string][]string{}
	var scripts []string
	_ = fs.WalkDir(root, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || (!strings.HasSuffix(p, ".js") && !strings.HasSuffix(p, ".mjs")) {
			return err
		}
		data, err := fs.ReadFile(root, p)
		if err != nil {
			return err
		}
		sum := sha512.Sum384(data)
		h := "sha384-" + base64.StdEncoding.EncodeToString(sum[:])
		byHash[h] = append(byHash[h], p)
		scripts = append(scripts, p)
		return nil
	})
	integrityRe := regexp.MustCompile(`sha384-[A-Za-z0-9+/]{64}`)
	pinned := map[string]bool{}
	var queue []string
	pin := func(text []byte) {
		for _, h := range integrityRe.FindAll(text, -1) {
			for _, f := range byHash[string(h)] {
				if !pinned[f] {
					pinned[f] = true
					queue = append(queue, f)
				}
			}
		}
	}
	for _, page := range []string{"index.html", "workbench.html"} {
		b, err := fs.ReadFile(root, page)
		if err != nil {
			t.Fatal(err)
		}
		pin(b)
	}
	for len(queue) > 0 {
		f := queue[0]
		queue = queue[1:]
		b, _ := fs.ReadFile(root, f)
		pin(b)
	}
	for _, s := range scripts {
		if !pinned[s] {
			t.Errorf("%s is not pinned by any SRI chain from the pages", s)
		}
	}
	if len(pinned) < 4 {
		t.Errorf("only %d scripts pinned: is dist/ built?", len(pinned))
	}
}
