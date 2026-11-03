package app

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"strings"
	"sync/atomic"

	"github.com/rs/zerolog"

	"memobrain/apps/desktop/internal/crypto"
	"memobrain/apps/desktop/internal/links"
	syncpkg "memobrain/apps/desktop/internal/sync"
	"memobrain/apps/desktop/internal/vault"
	"memobrain/shared/pathrules"
)

// Binding errors are messages "<code>: <text>" (Wails v2 has no typed
// errors): the frontend branches on the code (errorCode in the workbench's
// api.ts) and shows the text. These are the codes the file bindings return;
// the Wails mock of the workbench answers with the same messages.
const (
	ErrCodeConflict    = "conflict"     // the file changed on disk since it was read (or a plan went stale)
	ErrCodeExists      = "exists"       // the destination already exists
	ErrCodeNotFound    = "not-found"    // no such file or folder
	ErrCodeInvalidPath = "invalid-path" // the path leaves the vault or cannot be represented
	ErrCodePermission  = "permission"   // the operating system refused access
	ErrCodePartial     = "partial"      // a multi-file operation failed and could not be fully undone
	ErrCodeCancelled   = "cancelled"    // the operation was cancelled
	ErrCodeIO          = "io"           // another file system failure
	ErrCodeInternal    = "internal"     // a failure of the local index or another internal component
	// A new passphrase the policy refuses (crypto.ValidatePassphrase); the
	// text starts with the reason, crypto.WeakTooShort or crypto.WeakGuessable:
	// "weak-passphrase: too-short: the passphrase must have at least 12 characters".
	ErrCodeWeakPassphrase = "weak-passphrase"
)

// codedError is a binding error with a stable code; Unwrap keeps the cause
// for errors.Is in Go callers.
type codedError struct {
	code, text string
	cause      error
}

func (e *codedError) Error() string { return e.code + ": " + e.text }
func (e *codedError) Unwrap() error { return e.cause }

func coded(code, text string, cause error) error {
	return &codedError{code: code, text: text, cause: cause}
}

// bindingLog receives the details bindingError leaves out of the messages.
var bindingLog atomic.Pointer[zerolog.Logger]

func setBindingLogger(l zerolog.Logger) { bindingLog.Store(&l) }

// bindingError maps an error to the message a binding returns: a stable code
// and a text without absolute paths (which name the user) or database
// internals; those details go to the log. Errors that already carry a code
// pass through unchanged.
func bindingError(err error) error {
	var ce *codedError
	var pe *fs.PathError
	var le *os.LinkError
	var wp *crypto.WeakPassphraseError
	switch {
	case err == nil:
		return nil
	case errors.As(err, &ce):
		return err
	case errors.As(err, &wp):
		return coded(ErrCodeWeakPassphrase, wp.Reason+": "+wp.Error(), err)
	case errors.Is(err, syncpkg.ErrConflictChanged):
		return coded(ErrCodeConflict, err.Error(), err)
	case errors.Is(err, vault.ErrHashMismatch):
		return coded(ErrCodeConflict, "file changed on disk", err)
	case errors.Is(err, links.ErrStalePlan):
		return coded(ErrCodeConflict, err.Error(), err) // names vault-relative paths only
	case errors.Is(err, links.ErrPartialRollback):
		logBindingError(err)
		return coded(ErrCodePartial, "the operation failed and some notes could not be restored; see the log", err)
	case errors.Is(err, vault.ErrExists), errors.Is(err, fs.ErrExist):
		return coded(ErrCodeExists, "destination already exists", err)
	case errors.Is(err, vault.ErrNotFound):
		return coded(ErrCodeNotFound, "no such file", err)
	case errors.Is(err, vault.ErrOutsideVault):
		return coded(ErrCodeInvalidPath, "outside the vault", err)
	case errors.Is(err, pathrules.ErrInvalid):
		return coded(ErrCodeInvalidPath, err.Error(), err) // quotes the vault-relative path only
	case errors.Is(err, fs.ErrPermission):
		logBindingError(err)
		return coded(ErrCodePermission, "access denied by the operating system", err)
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return coded(ErrCodeCancelled, "the operation was cancelled", err)
	case errors.As(err, &pe):
		logBindingError(err)
		return coded(ErrCodeIO, pe.Op+": "+pe.Err.Error(), err)
	case errors.As(err, &le):
		logBindingError(err)
		return coded(ErrCodeIO, le.Op+": "+le.Err.Error(), err)
	case isDatabaseError(err):
		logBindingError(err)
		return coded(ErrCodeInternal, "local index error; see the log", err)
	default:
		return err
	}
}

// isDatabaseError recognises errors of database/sql and the SQLite drivers
// (native and browser), whose text quotes SQL and schema details.
func isDatabaseError(err error) bool {
	msg := err.Error()
	return strings.HasPrefix(msg, "sql: ") || strings.Contains(strings.ToLower(msg), "sqlite") || strings.Contains(msg, "SQL logic error")
}

func logBindingError(err error) {
	if l := bindingLog.Load(); l != nil {
		l.Warn().Err(err).Msg("binding error")
	}
}

// portableName checks a path a binding is about to create (a new note or
// folder, a rename or move destination) with the rule for new vault paths:
// a Windows device name ("CON.md", "nul") would work here but break every
// Windows device that syncs the vault.
func portableName(p string) error {
	if _, err := pathrules.NormalizePortable(p); err != nil {
		return bindingError(err)
	}
	return nil
}
