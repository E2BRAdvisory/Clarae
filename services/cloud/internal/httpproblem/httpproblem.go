// Package httpproblem writes RFC 9457 problem documents and defines the
// error type module handlers return to choose an application error code.
// It has no dependencies on other modules so every package can use it.
package httpproblem

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5/middleware"

	"clarae/shared/syncproto"
)

var titles = map[syncproto.Code]string{
	syncproto.CodeUnauthenticated:    "Authentication required",
	syncproto.CodeForbidden:          "Forbidden",
	syncproto.CodeUserSuspended:      "User suspended",
	syncproto.CodeNotFound:           "Not found",
	syncproto.CodeValidationFailed:   "Validation failed",
	syncproto.CodeQuotaExceeded:      "Storage quota exceeded",
	syncproto.CodeFileTooLarge:       "File too large",
	syncproto.CodeRevConflict:        "Revision conflict",
	syncproto.CodePathInvalid:        "Invalid path",
	syncproto.CodePathCollision:      "Path collision",
	syncproto.CodeShareRootMove:      "Share root cannot be moved",
	syncproto.CodeBlobMissing:        "Blob missing",
	syncproto.CodeVaultEncrypted:     "Operation not allowed on an encrypted vault",
	syncproto.CodeVaultKindImmutable: "Vault kind is immutable",
	syncproto.CodeRateLimited:        "Too many requests",
	syncproto.CodeCursorExpired:      "Cursor expired",
	syncproto.CodeNameInUse:          "Name already in use",
	syncproto.CodeInvalidState:       "Not allowed in the current state",
	syncproto.CodeInternal:           "Internal error",
}

// New builds the problem document for code.
func New(r *http.Request, code syncproto.Code, detail string, extra map[string]any) syncproto.Problem {
	title, ok := titles[code]
	if !ok {
		title = string(code)
	}
	return syncproto.Problem{
		Type:      syncproto.ProblemTypeBase + strings.ToLower(strings.ReplaceAll(string(code), "_", "-")),
		Title:     title,
		Status:    code.HTTPStatus(),
		Code:      code,
		Detail:    detail,
		RequestID: middleware.GetReqID(r.Context()),
		Extra:     extra,
	}
}

// Write sends an application/problem+json response.
func Write(w http.ResponseWriter, r *http.Request, code syncproto.Code, detail string, extra map[string]any) {
	p := New(r, code, detail, extra)
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(p.Status)
	_ = json.NewEncoder(w).Encode(p)
}

// Error is returned by handlers to produce a specific problem document.
type Error struct {
	Code   syncproto.Code
	Detail string
	Extra  map[string]any
	Err    error
}

func (e *Error) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("%s: %s: %v", e.Code, e.Detail, e.Err)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Detail)
}

// Unwrap exposes the cause.
func (e *Error) Unwrap() error { return e.Err }

// Errorf builds an Error with a formatted detail.
func Errorf(code syncproto.Code, format string, args ...any) *Error {
	return &Error{Code: code, Detail: fmt.Sprintf(format, args...)}
}

// NotFound is the generic 404 used both for missing resources and for
// resources the caller must not learn about (§3.7).
func NotFound(what string) *Error {
	return &Error{Code: syncproto.CodeNotFound, Detail: what + " not found"}
}
