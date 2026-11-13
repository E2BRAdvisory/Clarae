package httpserver

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5/middleware"

	"clarae/services/cloud/internal/httpproblem"
	"clarae/shared/syncproto"
)

const (
	// apiTimeout bounds a JSON operation, from authentication to response.
	apiTimeout = 60 * time.Second
	// maxJSONBody bounds a JSON request body. The largest legitimate one is a
	// commit of syncproto.MaxOpsPerCommit operations with encrypted paths,
	// about 2 MB in the worst case.
	maxJSONBody = 8 << 20
)

// apiLimits applies the request timeout and the body size limit to the
// generated operations, except those that stream bytes (blobs, exports):
// they have their own size caps, and a deadline would cut a large transfer
// or a slow client midway. tus and the SSE stream are mounted outside the
// generated router and are never wrapped.
func apiLimits(next http.Handler) http.Handler {
	timed := middleware.Timeout(apiTimeout)(next)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isStreaming(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		if r.ContentLength > maxJSONBody {
			writeBodyTooLarge(w, r)
			return
		}
		if r.Body != nil {
			r.Body = http.MaxBytesReader(w, r.Body, maxJSONBody)
		}
		timed.ServeHTTP(w, r)
	})
}

// isStreaming reports the operations whose request or response body is a
// byte stream: blob upload and download, revision content, vault ZIP, export
// download, and the personal data export. TestStreamingRoutesMatchOpenAPI
// keeps it in line with the binary responses of the contract.
func isStreaming(path string) bool {
	p, ok := strings.CutPrefix(path, BasePath)
	if !ok {
		return false
	}
	if p == "/me/export" {
		return true
	}
	rest, ok := strings.CutPrefix(p, "/vaults/")
	if !ok {
		return false
	}
	_, sub, ok := strings.Cut(rest, "/")
	if !ok {
		return false
	}
	switch {
	case sub == "export.zip":
		return true
	case strings.HasPrefix(sub, "blobs/"): // not blobs:check, which is JSON
		return true
	case strings.HasPrefix(sub, "exports/") && strings.HasSuffix(sub, "/download"):
		return true
	case strings.HasPrefix(sub, "files/") && strings.Contains(sub, "/revisions/") && strings.HasSuffix(sub, "/content"):
		return true
	}
	return false
}

func writeBodyTooLarge(w http.ResponseWriter, r *http.Request) {
	httpproblem.Write(w, r, syncproto.CodeFileTooLarge, fmt.Sprintf("request body larger than %d bytes", maxJSONBody), nil)
}

// writeRequestError reports a request that could not be decoded: too large
// (the body hit maxJSONBody while being read) or invalid.
func writeRequestError(w http.ResponseWriter, r *http.Request, err error) {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		writeBodyTooLarge(w, r)
		return
	}
	httpproblem.Write(w, r, syncproto.CodeValidationFailed, err.Error(), nil)
}
