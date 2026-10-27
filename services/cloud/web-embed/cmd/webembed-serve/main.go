// Command webembed-serve serves the embedded Web UI with the production handler and
// nothing else. It exists for the browser-level security test (web/e2e-security):
// the page is delivered exactly as the cloud binary delivers it, CSP included.
package main

import (
	"flag"
	"log"
	"net/http"
	"time"

	webembed "nodus/services/cloud/web-embed"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:18095", "listen address")
	issuer := flag.String("issuer", "https://id.example.invalid/realms/nodus", "OIDC issuer allowed in connect-src")
	flag.Parse()
	srv := &http.Server{
		Addr:              *addr,
		Handler:           webembed.Handler(webembed.Options{Issuer: *issuer}),
		ReadHeaderTimeout: 5 * time.Second,
	}
	log.Fatal(srv.ListenAndServe())
}
