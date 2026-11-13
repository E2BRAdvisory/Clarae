package webembed

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"
	"testing/fstest"
)

func gz(t *testing.T, data []byte) []byte {
	t.Helper()
	var b bytes.Buffer
	w := gzip.NewWriter(&b)
	if _, err := w.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func workbenchHandler(t *testing.T) (http.Handler, []byte) {
	t.Helper()
	wasm := bytes.Repeat([]byte("\x00asm-core-"), 1000)
	return Handler(Options{
		Issuer: "https://id.example.com:8443/realms/clarae",
		FS: fstest.MapFS{
			"index.html":                  {Data: []byte("<html>console</html>")},
			"workbench.html":              {Data: []byte("<html>workbench</html>")},
			"assets/workbench-1.js":       {Data: []byte("1")},
			"core/clarae-core-ab.wasm.gz": {Data: gz(t, wasm)},
		},
	}), wasm
}

func do(h http.Handler, target string, header map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, target, nil)
	for k, v := range header {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestWorkbenchRouteServesItsOwnPageAndPolicy(t *testing.T) {
	h, _ := workbenchHandler(t)
	// /vaults/new/open?kind=private&name=… is the creation route of a private vault (ADR-0037 §2).
	for _, p := range []string{"/vaults/0198f1c2-aaaa-7bbb-8ccc-123456789abc/open", "/vaults/x/open/", "/vaults/new/open?kind=private&name=Diary"} {
		rec := do(h, p, nil)
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "workbench") {
			t.Fatalf("%s: code %d body %q", p, rec.Code, rec.Body.String())
		}
		csp := rec.Header().Get("Content-Security-Policy")
		for _, want := range []string{
			"script-src 'self' 'wasm-unsafe-eval'", "style-src 'self' 'unsafe-inline'", "worker-src 'self' blob:;",
			"img-src 'self' data: blob:", "connect-src 'self' blob: https://id.example.com:8443;",
			"frame-ancestors 'none'", "object-src 'none'", "frame-src 'none'",
		} {
			if !strings.Contains(csp, want) {
				t.Errorf("%s: CSP %q lacks %q", p, csp, want)
			}
		}
		// Still no eval and no inline script, and nothing from another origin.
		if strings.Contains(strings.ReplaceAll(csp, "wasm-unsafe-eval", ""), "unsafe-eval") || strings.Contains(csp, "script-src 'self' 'unsafe-inline'") || strings.Contains(csp, "http:") {
			t.Errorf("%s: the workbench policy is too wide: %q", p, csp)
		}
		if rec.Header().Get("Cache-Control") != "no-cache" {
			t.Errorf("%s: the page must not be cached", p)
		}
	}
}

func TestOtherVaultAddressesStayInTheConsole(t *testing.T) {
	h, _ := workbenchHandler(t)
	for _, p := range []string{"/vaults", "/vaults/x", "/vaults/x/open/extra", "/vaults/x/opened", "/shares"} {
		rec := do(h, p, nil)
		if !strings.Contains(rec.Body.String(), "console") {
			t.Errorf("%s: got %q, want the console", p, rec.Body.String())
		}
		if got := rec.Header().Get("Content-Security-Policy"); strings.Contains(got, "unsafe-inline") {
			t.Errorf("%s: the console must keep the strict policy, got %q", p, got)
		}
	}
}

func TestWorkbenchRouteFallsBackToTheConsoleWithoutTheWorkbenchBuild(t *testing.T) {
	h := Handler(Options{FS: fstest.MapFS{"index.html": {Data: []byte("<html>console</html>")}}})
	rec := do(h, "/vaults/x/open", nil)
	if !strings.Contains(rec.Body.String(), "console") || strings.Contains(rec.Header().Get("Content-Security-Policy"), "unsafe-inline") {
		t.Fatalf("code %d body %q csp %q", rec.Code, rec.Body.String(), rec.Header().Get("Content-Security-Policy"))
	}
}

func TestWasmIsServedCompressedToBrowsersThatAcceptGzip(t *testing.T) {
	h, wasm := workbenchHandler(t)
	rec := do(h, "/core/clarae-core-ab.wasm", map[string]string{"Accept-Encoding": "gzip, deflate, br"})
	if rec.Code != http.StatusOK {
		t.Fatalf("code %d", rec.Code)
	}
	if rec.Header().Get("Content-Encoding") != "gzip" || rec.Header().Get("Content-Type") != "application/wasm" {
		t.Fatalf("headers %v", rec.Header())
	}
	if rec.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
		t.Fatalf("hashed files are immutable, got %q", rec.Header().Get("Cache-Control"))
	}
	if !strings.Contains(rec.Header().Get("Vary"), "Accept-Encoding") {
		t.Fatalf("Vary = %q", rec.Header().Get("Vary"))
	}
	zr, err := gzip.NewReader(rec.Body)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(zr)
	if !bytes.Equal(got, wasm) {
		t.Fatalf("the body does not decompress to the original (%d bytes)", len(got))
	}
}

func TestWasmIsDecompressedForClientsWithoutGzip(t *testing.T) {
	h, wasm := workbenchHandler(t)
	for _, enc := range []string{"", "identity", "gzip;q=0", "br"} {
		rec := do(h, "/core/clarae-core-ab.wasm", map[string]string{"Accept-Encoding": enc})
		if rec.Code != http.StatusOK || rec.Header().Get("Content-Encoding") != "" {
			t.Fatalf("%q: code %d encoding %q", enc, rec.Code, rec.Header().Get("Content-Encoding"))
		}
		if !bytes.Equal(rec.Body.Bytes(), wasm) || rec.Header().Get("Content-Type") != "application/wasm" {
			t.Fatalf("%q: body is not the original wasm (type %q)", enc, rec.Header().Get("Content-Type"))
		}
	}
}

func TestMissingWasmIs404(t *testing.T) {
	h, _ := workbenchHandler(t)
	if rec := do(h, "/core/other.wasm", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("code %d", rec.Code)
	}
}

func TestAcceptsGzip(t *testing.T) {
	for header, want := range map[string]bool{
		"": false, "gzip": true, "GZIP": true, "gzip, deflate": true, "deflate, br": false,
		"gzip;q=0": false, "gzip; q=0.0": false, "gzip;q=0.5": true, "br, gzip;q=1.0": true, "identity;q=1, *;q=0": false,
	} {
		if got := acceptsGzip(header); got != want {
			t.Errorf("acceptsGzip(%q) = %v, want %v", header, got, want)
		}
	}
}

// The workbench page's import map (SRI of the code-split chunks) is its only inline script: the policy
// allows exactly its text, by hash, and nothing else inline.
func TestWorkbenchPolicyAllowsOnlyItsImportMap(t *testing.T) {
	importMap := `{"integrity":{"/assets/chunk-A.js":"sha384-abc"}}`
	page := `<html><head><script type="importmap">` + importMap + `</script></head>` +
		`<body><script>alert(1)</script><script type="module" src="/assets/workbench-1.js"></script></body></html>`
	h := Handler(Options{FS: fstest.MapFS{
		"index.html":     {Data: []byte("<html>console</html>")},
		"workbench.html": {Data: []byte(page)},
	}})
	sum := sha256.Sum256([]byte(importMap))
	want := "'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'"
	wb := do(h, "/vaults/x/open", nil).Header().Get("Content-Security-Policy")
	p := csp(wb)
	if got := strings.Join(p["script-src"], " "); got != "'self' 'wasm-unsafe-eval' "+want {
		t.Fatalf("workbench script-src = %q, want the import map's hash %s and nothing else", got, want)
	}
	// The console has no import map and keeps its policy.
	if c := do(h, "/vaults", nil).Header().Get("Content-Security-Policy"); strings.Contains(c, "sha256-") {
		t.Fatalf("the console policy must not carry the workbench hash: %q", c)
	}
	if got := ImportMapHashes([]byte(`<script>x</script><script type="module">y</script>`)); got != nil {
		t.Fatalf("only import maps are hashed, got %v", got)
	}
}

// web/src/shared/routes.ts is the Web UI's copy of workbenchRoute (links, dev server, workbench entry):
// both must pick the same paths.
func TestWorkbenchRouteMatchesTheWebUI(t *testing.T) {
	src, err := os.ReadFile("../../../web/src/shared/routes.ts")
	if err != nil {
		t.Skipf("Web UI sources not available: %v", err)
	}
	m := regexp.MustCompile(`WORKBENCH_ROUTE_PATTERN = '([^']+)'`).FindSubmatch(src)
	if m == nil {
		t.Fatal("WORKBENCH_ROUTE_PATTERN not found in web/src/shared/routes.ts")
	}
	web := regexp.MustCompile(string(m[1]))
	for _, p := range []string{
		"/vaults/x/open", "/vaults/x/open/", "/vaults/0198f1c2-aaaa-7bbb-8ccc-123456789abc/open", "/vaults/new/open",
		"/vaults", "/vaults/x", "/vaults/x/open/extra", "/vaults/x/opened", "/vaults//open", "/a/vaults/x/open", "/shares",
	} {
		if got, want := web.MatchString(p), workbenchRoute.MatchString(p); got != want {
			t.Errorf("%s: the Web UI says %v, the cloud %v", p, got, want)
		}
	}
	if strings.ReplaceAll(strings.ReplaceAll(string(m[1]), "(", ""), ")", "") != workbenchRoute.String() {
		t.Errorf("patterns differ: web %q, cloud %q", m[1], workbenchRoute.String())
	}
}
