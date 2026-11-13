package webembed

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path"
	"regexp"
	"sort"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

// The measurements below run against a real Web UI build: set WEBEMBED_MEASURE_DIST to a production
// dist/ (web/dist after `yarn workspace @clarae/web run build`). They report what a browser
// downloads on a first visit and on a revisit, and the allocations of one request per file class.

func measureDist(tb testing.TB) string {
	dir := os.Getenv("WEBEMBED_MEASURE_DIST")
	if dir == "" {
		tb.Skip("WEBEMBED_MEASURE_DIST is not set")
	}
	return dir
}

// measurePaths lists what the two pages load: the pages, their subresources, the core worker, the
// Excalidraw bundle and the WebAssembly files (requested without .gz, as the page does).
func measurePaths(tb testing.TB, root fs.FS) []string {
	paths := []string{"/", "/vaults/x/open"}
	ref := regexp.MustCompile(`(?:src|href)="(/[^"]+)"`)
	seen := map[string]bool{}
	for _, page := range []string{"index.html", "workbench.html"} {
		b, err := fs.ReadFile(root, page)
		if err != nil {
			tb.Fatal(err)
		}
		for _, m := range ref.FindAllStringSubmatch(string(b), -1) {
			if !seen[m[1]] {
				seen[m[1]] = true
				paths = append(paths, m[1])
			}
		}
	}
	extra, _ := fs.Glob(root, "assets/core-worker-*.js")
	extra = append(extra, "excalidraw-assets/excalidraw.js")
	gz, _ := fs.Glob(root, "core/*.wasm.gz")
	for _, g := range gz {
		extra = append(extra, strings.TrimSuffix(g, ".gz"))
	}
	for _, e := range extra {
		paths = append(paths, "/"+e)
	}
	return paths
}

func TestMeasureBytesServed(t *testing.T) {
	root := os.DirFS(measureDist(t))
	h := Handler(Options{FS: root, Issuer: "https://id.example.com/realms/clarae"})
	var firstTotal, revisitTotal int64
	for _, p := range measurePaths(t, root) {
		req := httptest.NewRequest(http.MethodGet, p, nil)
		req.Header.Set("Accept-Encoding", "gzip, deflate, br")
		rec := httptest.NewRecorder()
		start := time.Now()
		h.ServeHTTP(rec, req)
		took := time.Since(start)
		first := int64(rec.Body.Len())
		firstTotal += first

		// A revisit only asks again for what is not immutable, with the validators it got.
		var again int64
		status := "cached"
		if !strings.Contains(rec.Header().Get("Cache-Control"), "immutable") {
			req2 := httptest.NewRequest(http.MethodGet, p, nil)
			req2.Header.Set("Accept-Encoding", "gzip, deflate, br")
			if et := rec.Header().Get("ETag"); et != "" {
				req2.Header.Set("If-None-Match", et)
			}
			if lm := rec.Header().Get("Last-Modified"); lm != "" {
				req2.Header.Set("If-Modified-Since", lm)
			}
			rec2 := httptest.NewRecorder()
			h.ServeHTTP(rec2, req2)
			again = int64(rec2.Body.Len())
			status = http.StatusText(rec2.Code)
		}
		revisitTotal += again
		t.Logf("%-50s %3d enc=%-4s first=%9d (%v) revisit=%9d (%s)", p, rec.Code, rec.Header().Get("Content-Encoding"), first, took.Round(time.Millisecond), again, status)
	}
	t.Logf("TOTAL first visit=%d bytes, revisit=%d bytes", firstTotal, revisitTotal)
}

// benchFS loads the measured files into memory, like the embedded build.
func benchFS(b *testing.B) (fs.FS, map[string]string) {
	dir := measureDist(b)
	root := os.DirFS(dir)
	m := fstest.MapFS{}
	paths := measurePaths(b, root)
	files := []string{"index.html", "workbench.html"}
	for _, p := range paths[2:] {
		name := strings.TrimPrefix(p, "/")
		if strings.HasSuffix(name, ".wasm") {
			name += ".gz"
		}
		files = append(files, name)
	}
	for _, f := range files {
		data, err := fs.ReadFile(root, f)
		if err != nil {
			b.Fatal(err)
		}
		m[f] = &fstest.MapFile{Data: data}
	}
	pick := func(pattern string) string {
		var out []string
		for _, p := range paths {
			if ok, _ := path.Match(pattern, p); ok {
				out = append(out, p)
			}
		}
		sort.Strings(out)
		if len(out) == 0 {
			b.Fatalf("no file matches %s", pattern)
		}
		return out[0]
	}
	return m, map[string]string{
		"index":      "/",
		"main-js":    pick("/assets/main-*.js"),
		"excalidraw": "/excalidraw-assets/excalidraw.js",
		"core-wasm":  pick("/core/clarae-core-*.wasm"),
	}
}

type discardWriter struct{ h http.Header }

func (d *discardWriter) Header() http.Header         { return d.h }
func (d *discardWriter) Write(p []byte) (int, error) { return len(p), nil }
func (d *discardWriter) WriteHeader(int)             {}

// BenchmarkServe measures one request per file class: a browser that accepts gzip, one that does not
// and a revalidation with the ETag of a previous answer.
func BenchmarkServe(b *testing.B) {
	root, targets := benchFS(b)
	h := Handler(Options{FS: root})
	for _, name := range []string{"index", "main-js", "excalidraw", "core-wasm"} {
		for _, enc := range []string{"gzip", "identity", "revalidate"} {
			b.Run(name+"/"+enc, func(b *testing.B) {
				req := httptest.NewRequest(http.MethodGet, targets[name], nil)
				if enc != "identity" {
					req.Header.Set("Accept-Encoding", "gzip, deflate, br")
				}
				if enc == "revalidate" {
					rec := httptest.NewRecorder()
					h.ServeHTTP(rec, req)
					if et := rec.Header().Get("ETag"); et != "" {
						req.Header.Set("If-None-Match", et)
					}
				}
				w := &discardWriter{h: http.Header{}}
				h.ServeHTTP(w, req) // one-time work (type table, compression, hashing) stays out of the numbers
				b.ReportAllocs()
				b.ResetTimer()
				for b.Loop() {
					clear(w.h)
					h.ServeHTTP(w, req)
				}
			})
		}
	}
}
