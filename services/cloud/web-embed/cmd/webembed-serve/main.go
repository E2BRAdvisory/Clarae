// Command webembed-serve serves the embedded Web UI with the production handler and
// nothing else. It exists for the browser-level security test (web/e2e-security):
// the page is delivered exactly as the cloud binary delivers it, CSP included.
package main

import (
	"flag"
	"io/fs"
	"log"
	"net/http"
	"os"
	"time"

	webembed "clarae/services/cloud/web-embed"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:18095", "listen address")
	issuer := flag.String("issuer", "https://id.example.invalid/realms/clarae", "OIDC issuer allowed in connect-src")
	dir := flag.String("dir", "", "serve this directory instead of the embedded build (browser tests of E2E builds)")
	flag.Parse()
	var root fs.FS // nil = the embedded build
	if *dir != "" {
		root = os.DirFS(*dir)
	}
	srv := &http.Server{
		Addr:              *addr,
		Handler:           webembed.Handler(webembed.Options{Issuer: *issuer, FS: root}),
		ReadHeaderTimeout: 5 * time.Second,
	}
	log.Fatal(srv.ListenAndServe())
}
