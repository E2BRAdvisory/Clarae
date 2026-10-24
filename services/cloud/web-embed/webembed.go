// Package webembed serves the Web UI single page application that is
// compiled into the binary (go:embed of the Vite build copied into dist/ by
// `make web-build`). It adds the strict Content Security Policy of §3.7, the
// cache policy (immutable hashed assets, no-cache index) and the SPA fallback.
package webembed

import (
	"bytes"
	"embed"
	"io/fs"
	"net/http"
	"net/url"
	"path"
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

// Options configure Handler.
type Options struct {
	// FS is the built SPA; nil means the embedded Dist().
	FS fs.FS
	// Issuer is the OIDC issuer URL; its origin is allowed in connect-src
	// because discovery and token calls go straight to Keycloak.
	Issuer string
}

// CSP builds the Content-Security-Policy value for an OIDC issuer.
func CSP(issuer string) string {
	connect := "'self'"
	if u, err := url.Parse(issuer); err == nil && u.Scheme != "" && u.Host != "" {
		connect += " " + u.Scheme + "://" + u.Host
	}
	return "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; " +
		"connect-src " + connect + "; frame-ancestors 'none'; base-uri 'none'; " +
		"form-action 'self'; object-src 'none'"
}

// Handler serves the SPA. API-looking paths are never answered with the
// index (they get a plain 404), and a missing path with a file extension is a
// 404 too, so a mistyped asset never turns into HTML.
func Handler(o Options) http.Handler {
	root := o.FS
	if root == nil {
		root = Dist()
	}
	csp := CSP(o.Issuer)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", csp)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")

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
				if strings.HasPrefix(name, "assets/") {
					h.Set("Cache-Control", "public, max-age=31536000, immutable")
				} else {
					h.Set("Cache-Control", "no-cache")
				}
				serveFile(w, r, root, name)
				return
			}
			if path.Ext(name) != "" {
				http.NotFound(w, r)
				return
			}
		}
		h.Set("Cache-Control", "no-cache")
		serveFile(w, r, root, "index.html")
	})
}

func serveFile(w http.ResponseWriter, r *http.Request, root fs.FS, name string) {
	data, err := fs.ReadFile(root, name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(data))
}
