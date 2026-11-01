package webembed

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"
)

func cacheHandler(t *testing.T) (http.Handler, map[string][]byte) {
	t.Helper()
	files := map[string][]byte{
		"index.html":             []byte("<html>" + strings.Repeat("console ", 200) + "</html>"),
		"assets/app-1.js":        []byte(strings.Repeat("console.log('memobrain');\n", 400)),
		"assets/tiny-1.js":       []byte("console.log(1)"),
		"icon.png":               bytes.Repeat([]byte{0x89, 'P', 'N', 'G'}, 400),
		"core/sqlite3-ab.wasm":   bytes.Repeat([]byte("\x00asm-sqlite-"), 500),
		"excalidraw-assets/x.js": []byte(strings.Repeat("export const excalidraw = 1;\n", 300)),
	}
	m := fstest.MapFS{}
	for k, v := range files {
		m[k] = &fstest.MapFile{Data: v}
	}
	return Handler(Options{FS: m}), files
}

func gunzip(t *testing.T, b []byte) []byte {
	t.Helper()
	zr, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	out, err := io.ReadAll(zr)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// Pages and the other no-cache files carry a strong ETag: a revalidation costs a 304, not the file.
func TestRevalidationIsAnsweredWithNotModified(t *testing.T) {
	h, _ := cacheHandler(t)
	for _, p := range []string{"/", "/vaults/x", "/excalidraw-assets/x.js", "/icon.png", "/assets/app-1.js"} {
		for _, enc := range []string{"", "gzip"} {
			first := do(h, p, map[string]string{"Accept-Encoding": enc})
			etag := first.Header().Get("ETag")
			if first.Code != http.StatusOK || !strings.HasPrefix(etag, `"`) || strings.HasPrefix(etag, "W/") {
				t.Fatalf("%s (%q): code %d ETag %q", p, enc, first.Code, etag)
			}
			again := do(h, p, map[string]string{"Accept-Encoding": enc, "If-None-Match": etag})
			if again.Code != http.StatusNotModified || again.Body.Len() != 0 {
				t.Fatalf("%s (%q): revalidation got %d with %d bytes", p, enc, again.Code, again.Body.Len())
			}
			if again.Header().Get("Content-Security-Policy") == "" || again.Header().Get("ETag") != etag {
				t.Fatalf("%s (%q): 304 lost its headers: %v", p, enc, again.Header())
			}
			if stale := do(h, p, map[string]string{"Accept-Encoding": enc, "If-None-Match": `"other"`}); stale.Code != http.StatusOK {
				t.Fatalf("%s (%q): a stale ETag got %d", p, enc, stale.Code)
			}
		}
	}
}

func TestTextFilesAreCompressedForBrowsersThatAcceptGzip(t *testing.T) {
	h, files := cacheHandler(t)
	for p, name := range map[string]string{"/assets/app-1.js": "assets/app-1.js", "/": "index.html", "/excalidraw-assets/x.js": "excalidraw-assets/x.js"} {
		rec := do(h, p, map[string]string{"Accept-Encoding": "gzip, deflate, br"})
		if rec.Code != http.StatusOK || rec.Header().Get("Content-Encoding") != "gzip" {
			t.Fatalf("%s: code %d encoding %q", p, rec.Code, rec.Header().Get("Content-Encoding"))
		}
		if !strings.Contains(rec.Header().Get("Vary"), "Accept-Encoding") || !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/") {
			t.Fatalf("%s: Vary %q Content-Type %q", p, rec.Header().Get("Vary"), rec.Header().Get("Content-Type"))
		}
		if rec.Body.Len() >= len(files[name]) || !bytes.Equal(gunzip(t, rec.Body.Bytes()), files[name]) {
			t.Fatalf("%s: %d compressed bytes do not decompress to the %d of the file", p, rec.Body.Len(), len(files[name]))
		}
		plain := do(h, p, map[string]string{"Accept-Encoding": "identity"})
		if plain.Header().Get("Content-Encoding") != "" || !bytes.Equal(plain.Body.Bytes(), files[name]) {
			t.Fatalf("%s: plain answer differs", p)
		}
		if plain.Header().Get("ETag") == rec.Header().Get("ETag") {
			t.Fatalf("%s: both representations share the ETag %q", p, plain.Header().Get("ETag"))
		}
		if !strings.Contains(plain.Header().Get("Vary"), "Accept-Encoding") {
			t.Fatalf("%s: plain answer lacks Vary", p)
		}
	}
}

func TestSmallAndBinaryFilesAreNotCompressed(t *testing.T) {
	h, files := cacheHandler(t)
	for p, name := range map[string]string{"/assets/tiny-1.js": "assets/tiny-1.js", "/icon.png": "icon.png"} {
		rec := do(h, p, map[string]string{"Accept-Encoding": "gzip"})
		if rec.Header().Get("Content-Encoding") != "" || !bytes.Equal(rec.Body.Bytes(), files[name]) {
			t.Fatalf("%s: encoding %q", p, rec.Header().Get("Content-Encoding"))
		}
	}
}

func TestRawWasmIsCompressedToo(t *testing.T) {
	h, files := cacheHandler(t)
	rec := do(h, "/core/sqlite3-ab.wasm", map[string]string{"Accept-Encoding": "gzip"})
	if rec.Header().Get("Content-Encoding") != "gzip" || rec.Header().Get("Content-Type") != "application/wasm" ||
		!bytes.Equal(gunzip(t, rec.Body.Bytes()), files["core/sqlite3-ab.wasm"]) {
		t.Fatalf("encoding %q type %q", rec.Header().Get("Content-Encoding"), rec.Header().Get("Content-Type"))
	}
}

// The stored gzip WebAssembly is streamed decompressed with its exact length, and revalidates.
func TestDecompressedWasmHasLengthAndValidator(t *testing.T) {
	h, wasm := workbenchHandler(t)
	rec := do(h, "/core/memobrain-core-ab.wasm", nil)
	if rec.Header().Get("Content-Length") != strconv.Itoa(len(wasm)) || !bytes.Equal(rec.Body.Bytes(), wasm) {
		t.Fatalf("Content-Length %q, body %d bytes, want %d", rec.Header().Get("Content-Length"), rec.Body.Len(), len(wasm))
	}
	etag := rec.Header().Get("ETag")
	compressed := do(h, "/core/memobrain-core-ab.wasm", map[string]string{"Accept-Encoding": "gzip"})
	if etag == "" || etag == compressed.Header().Get("ETag") {
		t.Fatalf("ETags: plain %q compressed %q", etag, compressed.Header().Get("ETag"))
	}
	if again := do(h, "/core/memobrain-core-ab.wasm", map[string]string{"If-None-Match": etag}); again.Code != http.StatusNotModified || again.Body.Len() != 0 {
		t.Fatalf("revalidation: %d", again.Code)
	}
	if head := get(h, http.MethodHead, "/core/memobrain-core-ab.wasm"); head.Code != http.StatusOK || head.Body.Len() != 0 ||
		head.Header().Get("Content-Length") != strconv.Itoa(len(wasm)) {
		t.Fatalf("HEAD: %d len %d Content-Length %q", head.Code, head.Body.Len(), head.Header().Get("Content-Length"))
	}
}

func TestEtagMatches(t *testing.T) {
	for header, want := range map[string]bool{
		``: false, `"a"`: true, `W/"a"`: true, `"b", "a"`: true, `*`: true, `"b"`: false, `"a-gz"`: false,
	} {
		if got := etagMatches(header, `"a"`); got != want {
			t.Errorf("%q: %v, want %v", header, got, want)
		}
	}
}

func TestTailWriter(t *testing.T) {
	var w tailWriter
	for _, chunk := range []string{"ab", "c", "defg", "h", "", "ij"} {
		_, _ = w.Write([]byte(chunk))
	}
	if string(w.b[:]) != "ghij" {
		t.Fatalf("tail %q", w.b[:])
	}
}
