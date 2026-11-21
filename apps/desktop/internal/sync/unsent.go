package sync

import (
	"context"
	"errors"
	"sort"
	"strings"

	"clarae/apps/desktop/internal/sync/transport"
	"clarae/apps/desktop/internal/vault"
	"clarae/shared/pathrules"
	"clarae/shared/syncproto"
)

// Local codes of File.LastError: failures that happen on this device, before the server sees the file
// (the server's codes are syncproto.Code). They are never sent.
const (
	CodeEncryptFailed    = "ENCRYPT_FAILED"     // the path or the content could not be encrypted
	CodeTooManyConflicts = "TOO_MANY_CONFLICTS" // concurrent edits kept winning over this one
)

// The reasons of UnsentItem (ADR-0066); their values are stable, the UI translates them.
const (
	UnsentTooLarge         = "too-large"          // over the size limit (FILE_TOO_LARGE)
	UnsentEncryptFailed    = "encrypt-failed"     // ENCRYPT_FAILED
	UnsentShareRootMove    = "share-root-move"    // a move that would empty a shared folder (SHARE_ROOT_MOVE)
	UnsentRejected         = "rejected"           // any other refusal of the server (Code says which)
	UnsentRetrying         = "retrying"           // failed, still being tried
	UnsentTooManyConflicts = "too-many-conflicts" // left to the conflict view
	UnsentAwaitingMerge    = "awaiting-merge"     // a server change is merged first (ADR-0039)
	UnsentInvalidName      = "invalid-name"       // a name the vault rules refuse (pathrules)
	UnsentSymlink          = "symlink"            // symlinks are never followed
	UnsentVCS              = "vcs"                // the folder of a version control system (informative)
	UnsentTrash            = "trash"              // the in-vault trash (informative)
)

// UnsentItem is a file (or a whole folder) this device does not send to the cloud, with the reason.
type UnsentItem struct {
	// Path is vault-relative; for an invalid name, the raw name made valid UTF-8.
	Path   string `json:"path"`
	IsDir  bool   `json:"isDir"`
	Reason string `json:"reason"`
	// Code is the server's or the local code (PATH_INVALID, FILE_TOO_LARGE, ENCRYPT_FAILED, …), "" when none.
	Code   string `json:"code"`
	Detail string `json:"detail"`
	// Retryable: RetryUnsent puts the file back in the queue.
	Retryable bool `json:"retryable"`
	// Info marks what is excluded on purpose (a version control folder, the trash): it needs nothing
	// and is not counted in Status.Unsent.
	Info bool `json:"info"`
}

// maxSkipped bounds the entries of a scan kept for the list (a vault full of symlinks must not grow
// the engine without end); the rest is counted in skippedDropped.
const maxSkipped = 1000

// lastError is the File.LastError of a code and a detail: "<CODE>: <detail>".
func lastError(code, detail string) string {
	switch {
	case code == "":
		return detail
	case detail == "":
		return code
	}
	return code + ": " + detail
}

// classifyLastError splits a File.LastError into its code and detail. It reads the "<CODE>: <detail>"
// form written by park, and the free text earlier versions wrote for the failures that had no code.
func classifyLastError(s string) (code, detail string) {
	if c, rest, ok := strings.Cut(s, ":"); ok && isCode(c) {
		return c, strings.TrimSpace(rest)
	}
	if isCode(s) {
		return s, ""
	}
	if c, _, ok := strings.Cut(s, " ("); ok && isCode(c) {
		return c, "" // "FILE_TOO_LARGE (413)": a problem without detail (transport.ProblemError)
	}
	switch {
	case strings.HasPrefix(s, "cannot encrypt the "):
		return CodeEncryptFailed, s
	case strings.HasPrefix(s, "too many concurrent edits"):
		return CodeTooManyConflicts, s
	}
	return "", s
}

// isCode reports whether s looks like an error code: upper-case letters, digits and underscores,
// starting with a letter.
func isCode(s string) bool {
	if len(s) < 3 {
		return false
	}
	for i, r := range s {
		switch {
		case r >= 'A' && r <= 'Z':
		case i > 0 && (r == '_' || (r >= '0' && r <= '9')):
		default:
			return false
		}
	}
	return true
}

// problemDetail is the detail of a problem the server returned, or the whole error.
func problemDetail(err error) string {
	var pe *transport.ProblemError
	if errors.As(err, &pe) {
		return pe.Problem.Detail
	}
	return err.Error()
}

// unsentOf is the item of a row with an error ("" Reason: not a file the list shows).
func unsentOf(r File) UnsentItem {
	if r.LastError == "" || r.LastError == quarantinedError {
		return UnsentItem{} // the quarantine is counted apart (Status.Quarantined): it concerns what comes in
	}
	code, detail := classifyLastError(r.LastError)
	it := UnsentItem{Path: r.Path, Code: code, Detail: detail}
	parked := r.Attempts >= MaxAttempts
	switch {
	case code == CodeTooManyConflicts || r.State == StateConflict:
		it.Reason = UnsentTooManyConflicts
	case !parked:
		it.Reason = UnsentRetrying
	case code == string(syncproto.CodeFileTooLarge):
		it.Reason, it.Retryable = UnsentTooLarge, true
	case code == CodeEncryptFailed:
		it.Reason, it.Retryable = UnsentEncryptFailed, true
	case code == string(syncproto.CodeShareRootMove):
		it.Reason, it.Retryable = UnsentShareRootMove, true
	default:
		it.Reason, it.Retryable = UnsentRejected, true
	}
	return it
}

// keepSkipped records, for the list, an entry the last scan left out (under e.mu, see walkLocal): names
// that cannot be represented, symlinks, version control folders and the trash. OS junk, temporary and
// device-local files are left out: nothing can be done about them.
func keepSkipped(out []UnsentItem, s vault.Skipped) []UnsentItem {
	var it UnsentItem
	switch s.Kind {
	case vault.SkipInvalidName:
		it = UnsentItem{Path: s.Path, IsDir: s.IsDir, Reason: UnsentInvalidName, Detail: s.Detail}
	case vault.SkipSymlink:
		it = UnsentItem{Path: s.Path, Reason: UnsentSymlink}
	case vault.SkipExcluded:
		switch s.Exclusion {
		case pathrules.ReasonVCS:
			it = UnsentItem{Path: s.Path, IsDir: s.IsDir, Reason: UnsentVCS, Info: true}
		case pathrules.ReasonTrash:
			it = UnsentItem{Path: s.Path, IsDir: s.IsDir, Reason: UnsentTrash, Info: true}
		default:
			return out
		}
	default:
		return out
	}
	return append(out, it)
}

// Unsent lists what this device does not send to the cloud, with the reason (ADR-0066): the files
// parked or failing (sync_files rows with an error), the ones held back by a server change to merge
// first, and what the last scan left out (invalid names, symlinks, version control folders, the
// trash). It reads sync.db and the engine's memory, never the disk, and does not wait for a running
// cycle. Items come grouped by reason, then by path.
func (e *Engine) Unsent(ctx context.Context) ([]UnsentItem, error) {
	rows, err := e.cfg.DB.ErrorFiles(ctx)
	if err != nil {
		return nil, err
	}
	out := []UnsentItem{}
	listed := map[string]bool{}
	for _, r := range rows {
		if it := unsentOf(r); it.Reason != "" {
			out = append(out, it)
			listed[r.FileID] = true
		}
	}
	pending, err := e.cfg.DB.Pending(ctx)
	if err != nil {
		return nil, err
	}
	for id := range pending {
		if listed[id] {
			continue
		}
		r, ok, err := e.cfg.DB.GetFileByID(ctx, id)
		if err != nil {
			return nil, err
		}
		if ok && r.State != StateSynced {
			out = append(out, UnsentItem{Path: r.Path, Reason: UnsentAwaitingMerge})
		}
	}
	e.mu.Lock()
	out = append(out, e.skipped...)
	e.mu.Unlock()
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Info != out[j].Info {
			return !out[i].Info
		}
		if out[i].Reason != out[j].Reason {
			return out[i].Reason < out[j].Reason
		}
		return out[i].Path < out[j].Path
	})
	return out, nil
}

// unsentCount is Status.Unsent: the items of Unsent that call for the user (not the informative ones,
// nor a file waiting for its merge, which the next cycle settles).
func (e *Engine) unsentCount(ctx context.Context) int {
	items, err := e.Unsent(ctx)
	if err != nil {
		return 0
	}
	n := 0
	for _, it := range items {
		if !it.Info && it.Reason != UnsentAwaitingMerge {
			n++
		}
	}
	return n
}

// RetryUnsent puts the parked files at paths back in the queue (every parked file when paths is
// empty), clearing their attempts and error; the next cycle sends them again. A file in conflict is
// left to the conflict view. It reports how many rows changed. It only touches those two columns, so
// it needs no pause of a running cycle (which never sends a parked file).
func (e *Engine) RetryUnsent(ctx context.Context, paths []string) (int, error) {
	return e.cfg.DB.Unpark(ctx, paths)
}
