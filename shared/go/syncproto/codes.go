// Package syncproto defines the wire types of the synchronization protocol
// (Specifications.md §3.1, §3.4, §3.5.3) shared by the cloud service and the
// desktop sync engine: operations, commit and changes payloads, application
// error codes and the RFC 9457 problem document.
//
// api/openapi.yaml is the normative contract. These are the domain types of
// both sides; the HTTP layers convert them to and from the types generated from
// the spec (services/cloud/internal/api on the server, memobrain/shared/apiclient
// in the desktop transport), so a schema change breaks the build there rather
// than the wire. Problem is the exception, written as is by the server: the
// cloud integration tests validate those responses against the spec, and
// TestCodesMatchOpenAPI keeps the Code constants equal to the ErrorCode enum.
package syncproto

import "net/http"

// Code is an application error code carried in Problem.Code and in rejected
// commit operations.
type Code string

// Application error codes (§3.1).
const (
	CodeUnauthenticated    Code = "UNAUTHENTICATED"
	CodeForbidden          Code = "FORBIDDEN"
	CodeUserSuspended      Code = "USER_SUSPENDED"
	CodeNotFound           Code = "NOT_FOUND"
	CodeValidationFailed   Code = "VALIDATION_FAILED"
	CodeQuotaExceeded      Code = "QUOTA_EXCEEDED"
	CodeFileTooLarge       Code = "FILE_TOO_LARGE"
	CodeRevConflict        Code = "REV_CONFLICT"
	CodePathInvalid        Code = "PATH_INVALID"
	CodePathCollision      Code = "PATH_COLLISION"
	CodeShareRootMove      Code = "SHARE_ROOT_MOVE"
	CodeBlobMissing        Code = "BLOB_MISSING"
	CodeVaultEncrypted     Code = "VAULT_ENCRYPTED"
	CodeVaultKindImmutable Code = "VAULT_KIND_IMMUTABLE"
	CodeRateLimited        Code = "RATE_LIMITED"
	CodeCursorExpired      Code = "CURSOR_EXPIRED"
	CodeNameInUse          Code = "NAME_IN_USE"
	CodeInvalidState       Code = "INVALID_STATE"
	CodeInternal           Code = "INTERNAL"
)

// ReasonDeviceRevoked is Problem.Extra["reason"] of the FORBIDDEN answer to a
// commit sent with a revoked device_id: the client stops synchronizing until
// the device is registered again.
const ReasonDeviceRevoked = "device_revoked"

// HTTPStatus returns the HTTP status associated with a code when it is the
// outcome of a whole request (per-operation outcomes inside a commit are
// always carried in a 200 response).
func (c Code) HTTPStatus() int {
	switch c {
	case CodeUnauthenticated:
		return http.StatusUnauthorized
	case CodeForbidden, CodeUserSuspended:
		return http.StatusForbidden
	case CodeNotFound:
		return http.StatusNotFound
	case CodeValidationFailed, CodePathInvalid:
		return http.StatusBadRequest
	case CodeQuotaExceeded, CodeFileTooLarge:
		return http.StatusRequestEntityTooLarge
	case CodeRevConflict, CodeNameInUse, CodeInvalidState, CodePathCollision, CodeShareRootMove, CodeVaultEncrypted, CodeVaultKindImmutable:
		return http.StatusConflict
	case CodeBlobMissing:
		return http.StatusUnprocessableEntity
	case CodeRateLimited:
		return http.StatusTooManyRequests
	case CodeCursorExpired:
		return http.StatusGone
	default:
		return http.StatusInternalServerError
	}
}

// ProblemTypeBase is the prefix of Problem.Type URIs.
const ProblemTypeBase = "https://memobrain.example/errors/"

// Problem is the application/problem+json body (RFC 9457) with the
// application-specific Code and request id (§3.1).
type Problem struct {
	Type      string         `json:"type"`
	Title     string         `json:"title"`
	Status    int            `json:"status"`
	Code      Code           `json:"code"`
	Detail    string         `json:"detail,omitempty"`
	RequestID string         `json:"request_id,omitempty"`
	Extra     map[string]any `json:"extra,omitempty"`
}
