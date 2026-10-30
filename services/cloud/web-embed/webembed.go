// Package webembed serves the Web UI single page application that is
// compiled into the binary (go:embed of the esbuild build copied into dist/ by
// `make web-build`). It adds the strict Content Security Policy of §3.7, the
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
	"embed"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
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
func WorkbenchCSP(issuer string) string {
	connect := "'self' blob:"
	if o := issuerOrigin(issuer); o != "" {
		connect += " " + o
	}
	return "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
		"img-src 'self' data: blob:; font-src 'self' data:; connect-src " + connect + "; " +
		"media-src 'self' blob:; worker-src 'self'; frame-src 'none'; frame-ancestors 'none'; " +
		"base-uri 'none'; form-action 'self'; object-src 'none'"
}

// workbenchRoute matches /vaults/:id/open, the only address of the workbench page.
var workbenchRoute = regexp.MustCompile(`^/vaults/[^/]+/open/?$`)

// permissionsPolicy turns off every powerful browser feature the Web UI never uses.
const permissionsPolicy = "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()"

// Handler serves the SPA. API-looking paths are never answered with the
// index (they get a plain 404), and a missing path with a file extension is a
// 404 too, so a mistyped asset never turns into HTML.
func Handler(o Options) http.Handler {
	root := o.FS
	if root == nil {
		root = Dist()
	}
	csp := CSP(o.Issuer)
	workbenchCSP := WorkbenchCSP(o.Issuer)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		page := "index.html"
		if workbenchRoute.MatchString(path.Clean("/" + r.URL.Path)) {
			// The workbench is its own document: its policy and its style sheet must not touch the console.
			if _, err := fs.Stat(root, "workbench.html"); err == nil {
				page = "workbench.html"
			}
		}
		if page == "workbench.html" {
			h.Set("Content-Security-Policy", workbenchCSP)
		} else {
			h.Set("Content-Security-Policy", csp)
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
			if st, err := fs.Stat(root, name); err == nil && !st.IsDir() {
				if strings.HasPrefix(name, "assets/") || strings.HasPrefix(name, "core/") {
					h.Set("Cache-Control", "public, max-age=31536000, immutable")
				} else {
					h.Set("Cache-Control", "no-cache")
				}
				serveFile(w, r, root, name)
				return
			}
			// WebAssembly files are kept compressed: name.wasm is answered from name.wasm.gz.
			if strings.HasSuffix(name, ".wasm") {
				if _, err := fs.Stat(root, name+".gz"); err == nil {
					h.Set("Cache-Control", "public, max-age=31536000, immutable")
					serveGzipped(w, r, root, name+".gz")
					return
				}
			}
			if path.Ext(name) != "" {
				http.NotFound(w, r)
				return
			}
		}
		h.Set("Cache-Control", "no-cache")
		serveFile(w, r, root, page)
	})
}

// serveGzipped answers a request for a file stored as name.gz: the compressed bytes go out as they are
// to a client that accepts gzip, a decompressed copy to one that does not.
func serveGzipped(w http.ResponseWriter, r *http.Request, root fs.FS, gzName string) {
	data, err := fs.ReadFile(root, gzName)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "application/wasm")
	h.Add("Vary", "Accept-Encoding")
	if acceptsGzip(r.Header.Get("Accept-Encoding")) {
		h.Set("Content-Encoding", "gzip")
		http.ServeContent(w, r, gzName, time.Time{}, bytes.NewReader(data))
		return
	}
	zr, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		http.Error(w, "corrupt asset", http.StatusInternalServerError)
		return
	}
	defer func() { _ = zr.Close() }()
	raw, err := io.ReadAll(zr)
	if err != nil {
		http.Error(w, "corrupt asset", http.StatusInternalServerError)
		return
	}
	http.ServeContent(w, r, strings.TrimSuffix(gzName, ".gz"), time.Time{}, bytes.NewReader(raw))
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

func serveFile(w http.ResponseWriter, r *http.Request, root fs.FS, name string) {
	data, err := fs.ReadFile(root, name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	// Types missing from Go's built-in table (the image may have no /etc/mime.types): the PWA manifest
	// and the favicon would otherwise be sniffed as text/plain and image/x-icon.
	if t, ok := extraTypes[path.Ext(name)]; ok {
		w.Header().Set("Content-Type", t)
	}
	http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(data))
}
