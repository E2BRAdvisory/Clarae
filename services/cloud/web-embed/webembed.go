// Package webembed serves the Web UI single page application that is
// compiled into the binary (go:embed of the esbuild build copied into dist/ by
// `task web-build`). It adds the strict Content Security Policy of §3.7, the
// cache policy (immutable hashed assets, no-cache index) and the SPA fallback.
//
// Two pages are served: the console (index.html, the SPA) and the vault workbench (workbench.html, for
// /vaults/:id/open), which runs the desktop UI and the Go core as WebAssembly in the browser (ADR-0029).
// The workbench needs a slightly wider policy, so it gets its own; the console keeps the strict one. The
// WebAssembly files are stored gzip-compressed (the core is 36 MB raw) and served as they are to browsers
// that accept gzip, or decompressed for the rest.
package webembed

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"embed"
	"encoding/base64"
	"encoding/binary"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed all:dist
var embedded embed.FS

// Dist returns the embedded build rooted at dist/.
func Dist() fs.FS {
	sub, err := fs.Sub(embedded, "dist")
	if err != nil {
		panic(err) // dist/ is part of the embed pattern, so this cannot happen
	}
	return sub
}

// extraTypes are the Content-Type of the static files whose extension Go does not know.
var extraTypes = map[string]string{
	".webmanifest": "application/manifest+json",
	".ico":         "image/vnd.microsoft.icon",
	".mjs":         "text/javascript; charset=utf-8",
}

// Options configure Handler.
type Options struct {
	// FS is the built SPA; nil means the embedded Dist().
	FS fs.FS
	// Issuer is the OIDC issuer URL; its origin is allowed in connect-src
	// because discovery and token calls go straight to Keycloak.
	Issuer string
}

// issuerOrigin is the origin of the OIDC issuer URL, or "" when it is not a URL.
func issuerOrigin(issuer string) string {
	if u, err := url.Parse(issuer); err == nil && u.Scheme != "" && u.Host != "" {
		return u.Scheme + "://" + u.Host
	}
	return ""
}

// CSP builds the Content-Security-Policy value of the console for an OIDC issuer.
func CSP(issuer string) string {
	connect := "'self'"
	if o := issuerOrigin(issuer); o != "" {
		connect += " " + o
	}
	return "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; " +
		"connect-src " + connect + "; frame-ancestors 'none'; base-uri 'none'; " +
		"form-action 'self'; object-src 'none'"
}

// WorkbenchCSP is the policy of the vault workbench page. It is the desktop's release policy (no remote
// resources, no eval; 'wasm-unsafe-eval' only to compile WebAssembly) plus what a page needs to reach
// the cloud: the API and the OIDC issuer. Styles may be inline because CodeMirror, KaTeX and Excalidraw
// compute them; scripts may not, and nothing from another origin is ever loaded (D-01, V-02).
// worker-src allows blob: because the workers (the core, the graph layout, pdf.js) start from the bytes
// the page fetched with Subresource Integrity (web/src/workbench/sri.ts): new Worker() has no integrity
// of its own.
//
// importMapHashes are the 'sha256-…' sources of the page's inline import map, the only inline script it
// has: it pins every code-split chunk with SRI (ADR-0029). Only that exact text is allowed, never
// inline script in general.
func WorkbenchCSP(issuer string, importMapHashes ...string) string {
	connect := "'self' blob:"
	if o := issuerOrigin(issuer); o != "" {
		connect += " " + o
	}
	script := "'self' 'wasm-unsafe-eval'"
	for _, h := range importMapHashes {
		script += " " + h
	}
	return "default-src 'self'; script-src " + script + "; style-src 'self' 'unsafe-inline'; " +
		"img-src 'self' data: blob:; font-src 'self' data:; connect-src " + connect + "; " +
		"media-src 'self' blob:; worker-src 'self' blob:; frame-src 'none'; frame-ancestors 'none'; " +
		"base-uri 'none'; form-action 'self'; object-src 'none'"
}

// workbenchRoute matches /vaults/:id/open, the only address of the workbench page. The same pattern is
// in web/src/shared/routes.ts (the console's links, the dev server, the workbench entry); a test keeps
// the two equal.
var workbenchRoute = regexp.MustCompile(`^/vaults/[^/]+/open/?$`)

// importMapRe finds the inline import maps of a page and their exact text, which is what a CSP hash
// source covers.
var importMapRe = regexp.MustCompile(`(?is)<script\s+type="importmap"\s*>(.*?)</script>`)

// ImportMapHashes returns the CSP hash sources ('sha256-<base64>') of the import maps inlined in a page,
// in page order. Other inline scripts get no hash: the policy keeps refusing them.
func ImportMapHashes(page []byte) []string {
	var out []string
	for _, m := range importMapRe.FindAllSubmatch(page, -1) {
		sum := sha256.Sum256(m[1])
		out = append(out, "'sha256-"+base64.StdEncoding.EncodeToString(sum[:])+"'")
	}
	return out
}

// permissionsPolicy turns off every powerful browser feature the Web UI never uses.
const permissionsPolicy = "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()"

// Handler serves the SPA. API-looking paths are never answered with the
// index (they get a plain 404), and a missing path with a file extension is a
// 404 too, so a mistyped asset never turns into HTML.
//
// Every file gets a strong ETag (computed once, on its first request), so the pages and the
// other files that browsers must revalidate are answered with 304 when unchanged. Text files
// are gzip-compressed once, on their first request, and the compressed copy is kept for the
// browsers that accept gzip; the rest are streamed straight from the build without a copy.
func Handler(o Options) http.Handler {
	root := o.FS
	if root == nil {
		root = Dist()
	}
	// The workbench page is read once: its import map is fixed for the life of the build.
	var hashes []string
	if page, err := fs.ReadFile(root, "workbench.html"); err == nil {
		hashes = ImportMapHashes(page)
	}
	s := &server{root: root, csp: CSP(o.Issuer), workbenchCSP: WorkbenchCSP(o.Issuer, hashes...)}
	return http.HandlerFunc(s.serveHTTP)
}

// server holds the build and what was learned about its files.
type server struct {
	root         fs.FS
	csp          string
	workbenchCSP string
	// files caches one *asset per file that exists (never a miss: the set is bounded by the build).
	files sync.Map
}

func (s *server) serveHTTP(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	page := s.asset("index.html")
	if workbenchRoute.MatchString(path.Clean("/" + r.URL.Path)) {
		// The workbench is its own document: its policy and its style sheet must not touch the console.
		if wb := s.asset("workbench.html"); wb != nil {
			page = wb
		}
	}
	if page != nil && page.name == "workbench.html" {
		h.Set("Content-Security-Policy", s.workbenchCSP)
	} else {
		h.Set("Content-Security-Policy", s.csp)
	}
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("X-Frame-Options", "DENY")
	h.Set("Cross-Origin-Opener-Policy", "same-origin")
	h.Set("Permissions-Policy", permissionsPolicy)

	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		h.Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	p := path.Clean("/" + r.URL.Path)
	if p == "/api" || strings.HasPrefix(p, "/api/") {
		http.NotFound(w, r)
		return
	}
	name := strings.TrimPrefix(p, "/")
	if name != "" {
		if a := s.asset(name); a != nil {
			// Every file under assets/ and core/ carries its hash in its name (web/scripts/esbuild.mjs).
			if strings.HasPrefix(name, "assets/") || strings.HasPrefix(name, "core/") {
				h.Set("Cache-Control", "public, max-age=31536000, immutable")
			} else {
				h.Set("Cache-Control", "no-cache")
			}
			s.serve(w, r, a)
			return
		}
		if path.Ext(name) != "" {
			http.NotFound(w, r)
			return
		}
	}
	h.Set("Cache-Control", "no-cache")
	if page == nil {
		http.NotFound(w, r)
		return
	}
	s.serve(w, r, page)
}

// asset returns the file served for name, or nil when there is none. WebAssembly files are kept
// compressed: name.wasm is answered from name.wasm.gz.
func (s *server) asset(name string) *asset {
	if a, ok := s.files.Load(name); ok {
		return a.(*asset)
	}
	a := &asset{name: name, file: name}
	if st, err := fs.Stat(s.root, name); err != nil || !st.Mode().IsRegular() {
		if !strings.HasSuffix(name, ".wasm") {
			return nil
		}
		if st, err := fs.Stat(s.root, name+".gz"); err != nil || !st.Mode().IsRegular() {
			return nil
		}
		a.file, a.stored = name+".gz", true
	}
	a.ctype = contentType(name)
	a.compressible = a.ctype != "" && compressible[path.Ext(name)]
	got, _ := s.files.LoadOrStore(name, a)
	return got.(*asset)
}

// asset is one file of the build and its lazily computed metadata.
type asset struct {
	name  string // the requested name
	file  string // the file in the build: name, or name.gz when stored compressed
	ctype string // Content-Type ("" lets ServeContent sniff it)
	// stored: the build keeps only a gzip copy (file is name.gz).
	stored bool
	// compressible: a text type worth compressing for the browsers that accept gzip.
	compressible bool

	metaOnce sync.Once
	tag      string // hash of the bytes in the build, the base of the ETags
	rawSize  int64  // stored only: the decompressed size, from the gzip trailer
	metaErr  error

	gzOnce sync.Once
	gz     []byte // compressible only: the gzip copy (nil when it does not pay off)
}

// meta hashes the file once.
func (a *asset) meta(root fs.FS) error {
	a.metaOnce.Do(func() {
		f, err := root.Open(a.file)
		if err != nil {
			a.metaErr = err
			return
		}
		defer func() { _ = f.Close() }()
		sum := sha256.New()
		var tail tailWriter
		if _, err := io.Copy(io.MultiWriter(sum, &tail), f); err != nil {
			a.metaErr = err
			return
		}
		a.tag = base64.RawURLEncoding.EncodeToString(sum.Sum(nil)[:18])
		if a.stored {
			// ISIZE: the decompressed length modulo 2^32, exact for files under 4 GiB.
			a.rawSize = int64(binary.LittleEndian.Uint32(tail.b[:]))
		}
	})
	return a.metaErr
}

// gzipped returns the compressed copy of a text file, made on the first call.
func (a *asset) gzipped(root fs.FS) []byte {
	a.gzOnce.Do(func() {
		data, err := fs.ReadFile(root, a.file)
		if err != nil || len(data) < minCompressSize {
			return
		}
		var b bytes.Buffer
		zw, _ := gzip.NewWriterLevel(&b, gzip.BestCompression)
		if _, err := zw.Write(data); err != nil || zw.Close() != nil {
			return
		}
		// Keep the copy only when it saves at least a tenth.
		if b.Len() < len(data)-len(data)/10 {
			a.gz = bytes.Clone(b.Bytes())
		}
	})
	return a.gz
}

// minCompressSize is the smallest file worth compressing: below it the headers dominate.
const minCompressSize = 512

// compressible lists the text types compressed for browsers that accept gzip. Fonts in woff/woff2
// and images are compressed already.
var compressible = map[string]bool{
	".html": true, ".js": true, ".mjs": true, ".css": true, ".svg": true, ".json": true,
	".webmanifest": true, ".map": true, ".txt": true, ".xml": true, ".wasm": true, ".ttf": true, ".otf": true,
}

// contentType is the Content-Type of a file name, "" when unknown.
func contentType(name string) string {
	// Types missing from Go's built-in table (the image may have no /etc/mime.types): the PWA manifest
	// and the favicon would otherwise be sniffed as text/plain and image/x-icon.
	if t, ok := extraTypes[path.Ext(name)]; ok {
		return t
	}
	return mime.TypeByExtension(path.Ext(name))
}

// serve answers with the representation the client accepts: the gzip copy (kept in the build or
// made once) when it accepts gzip, the plain bytes otherwise. Each representation has its own
// strong ETag, so a revalidation is answered with 304 when the file did not change.
func (s *server) serve(w http.ResponseWriter, r *http.Request, a *asset) {
	if err := a.meta(s.root); err != nil {
		http.NotFound(w, r)
		return
	}
	h := w.Header()
	if a.ctype != "" {
		h.Set("Content-Type", a.ctype)
	}
	gz := acceptsGzip(r.Header.Get("Accept-Encoding"))
	switch {
	case a.stored:
		h.Add("Vary", "Accept-Encoding")
		if gz {
			h.Set("Content-Encoding", "gzip")
			h.Set("ETag", `"`+a.tag+`"`)
			s.serveFile(w, r, a.file)
			return
		}
		h.Set("ETag", `"`+a.tag+`-id"`)
		s.serveDecompressed(w, r, a)
	case a.compressible:
		h.Add("Vary", "Accept-Encoding")
		if data := a.gzipped(s.root); gz && data != nil {
			h.Set("Content-Encoding", "gzip")
			h.Set("ETag", `"`+a.tag+`-gz"`)
			http.ServeContent(w, r, a.name, time.Time{}, bytes.NewReader(data))
			return
		}
		h.Set("ETag", `"`+a.tag+`"`)
		s.serveFile(w, r, a.file)
	default:
		h.Set("ETag", `"`+a.tag+`"`)
		s.serveFile(w, r, a.file)
	}
}

// serveFile streams a file of the build. Embedded files (and those of the other file systems in
// use) can seek, so ServeContent reads them in place, with ranges and conditional requests.
func (s *server) serveFile(w http.ResponseWriter, r *http.Request, name string) {
	f, err := s.root.Open(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer func() { _ = f.Close() }()
	if rs, ok := f.(io.ReadSeeker); ok {
		http.ServeContent(w, r, name, time.Time{}, rs)
		return
	}
	data, err := io.ReadAll(f)
	if err != nil {
		http.Error(w, "unreadable asset", http.StatusInternalServerError)
		return
	}
	http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(data))
}

// serveDecompressed streams a file stored as name.gz to a client that does not accept gzip,
// decompressing on the fly instead of holding the whole file (the core is 36 MB raw). Ranges are
// not supported on this path: the whole file is sent.
func (s *server) serveDecompressed(w http.ResponseWriter, r *http.Request, a *asset) {
	if etagMatches(r.Header.Get("If-None-Match"), w.Header().Get("ETag")) {
		h := w.Header()
		h.Del("Content-Type")
		w.WriteHeader(http.StatusNotModified)
		return
	}
	f, err := s.root.Open(a.file)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer func() { _ = f.Close() }()
	zr, err := gzip.NewReader(f)
	if err != nil {
		http.Error(w, "corrupt asset", http.StatusInternalServerError)
		return
	}
	defer func() { _ = zr.Close() }()
	w.Header().Set("Content-Length", strconv.FormatInt(a.rawSize, 10))
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	// Bounded by the announced length; a corrupt file ends the response early and the client sees a
	// short body.
	_, _ = io.CopyN(w, zr, a.rawSize)
}

// etagMatches reports whether an If-None-Match header lists etag (weak comparison, RFC 9110 13.1.2).
func etagMatches(header, etag string) bool {
	if header == "" {
		return false
	}
	if strings.TrimSpace(header) == "*" {
		return true
	}
	for _, t := range strings.Split(header, ",") {
		if strings.TrimPrefix(strings.TrimSpace(t), "W/") == etag {
			return true
		}
	}
	return false
}

// tailWriter keeps the last four bytes written to it.
type tailWriter struct{ b [4]byte }

func (t *tailWriter) Write(p []byte) (int, error) {
	if len(p) >= 4 {
		copy(t.b[:], p[len(p)-4:])
	} else {
		copy(t.b[:], append(t.b[len(p):], p...))
	}
	return len(p), nil
}

// acceptsGzip reports whether an Accept-Encoding header lists gzip (and does not rule it out with q=0).
func acceptsGzip(header string) bool {
	for _, part := range strings.Split(header, ",") {
		coding, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		if !strings.EqualFold(strings.TrimSpace(coding), "gzip") {
			continue
		}
		// "gzip;q=0" means "not acceptable"; any other weight (or none) accepts it.
		if q, ok := strings.CutPrefix(strings.ReplaceAll(params, " ", ""), "q="); ok {
			if w, err := strconv.ParseFloat(q, 64); err == nil && w == 0 {
				return false
			}
		}
		return true
	}
	return false
}
