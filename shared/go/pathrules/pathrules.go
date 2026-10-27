// Package pathrules validates and normalizes vault-relative file paths.
//
// It implements the rules of Specifications.md §3.4.2 and is shared by the
// desktop client (before writing to disk or committing) and the cloud service
// (before accepting a commit). Paths are always relative to the vault root,
// use '/' as separator and are stored NFC-normalized; the case-insensitive
// identity used for uniqueness (files.path_key) is produced by Key.
//
// The package deliberately knows nothing about the file system: symlink
// checks and other on-disk concerns belong to the client's vault package.
package pathrules

import (
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/cases"
	"golang.org/x/text/unicode/norm"
)

const (
	// MaxPathBytes is the maximum length of a whole path, in bytes (UTF-8, NFC).
	MaxPathBytes = 1024
	// MaxSegmentBytes is the maximum length of a single path segment, in bytes.
	MaxSegmentBytes = 255
)

// ErrInvalid is wrapped by every error returned from this package; callers map
// it to the PATH_INVALID application error code.
var ErrInvalid = errors.New("invalid path")

// Error describes why a path was rejected.
type Error struct {
	Path   string
	Reason string
}

func (e *Error) Error() string { return fmt.Sprintf("invalid path %q: %s", e.Path, e.Reason) }

// Unwrap lets errors.Is(err, ErrInvalid) succeed.
func (e *Error) Unwrap() error { return ErrInvalid }

func invalid(path, reason string) error { return &Error{Path: path, Reason: reason} }

// forbiddenChars are never allowed in a path segment (§3.4.2). Control
// characters are rejected separately.
const forbiddenChars = "\\:*?\"<>|"

// windowsReserved lists device names that Windows refuses as file names,
// regardless of extension and case.
var windowsReserved = map[string]struct{}{
	"CON": {}, "PRN": {}, "AUX": {}, "NUL": {},
	"COM1": {}, "COM2": {}, "COM3": {}, "COM4": {}, "COM5": {}, "COM6": {}, "COM7": {}, "COM8": {}, "COM9": {},
	"LPT1": {}, "LPT2": {}, "LPT3": {}, "LPT4": {}, "LPT5": {}, "LPT6": {}, "LPT7": {}, "LPT8": {}, "LPT9": {},
}

// Normalize validates p and returns its canonical form: UTF-8, NFC, '/'
// separated, no leading/trailing/duplicate separators. It returns an error
// wrapping ErrInvalid when the path violates any rule of §3.4.2.
func Normalize(p string) (string, error) {
	if p == "" {
		return "", invalid(p, "empty")
	}
	if !utf8.ValidString(p) {
		return "", invalid(p, "not valid UTF-8")
	}
	n := norm.NFC.String(p)
	if len(n) > MaxPathBytes {
		return "", invalid(p, fmt.Sprintf("longer than %d bytes", MaxPathBytes))
	}
	if strings.HasPrefix(n, "/") {
		return "", invalid(p, "absolute path")
	}
	for _, seg := range strings.Split(n, "/") {
		if err := checkSegment(p, seg); err != nil {
			return "", err
		}
	}
	return n, nil
}

func checkSegment(path, seg string) error {
	switch seg {
	case "":
		return invalid(path, "empty segment")
	case ".", "..":
		return invalid(path, "relative segment "+seg)
	}
	if len(seg) > MaxSegmentBytes {
		return invalid(path, fmt.Sprintf("segment longer than %d bytes", MaxSegmentBytes))
	}
	if strings.ContainsAny(seg, forbiddenChars) {
		return invalid(path, "forbidden character in "+seg)
	}
	for _, r := range seg {
		if r < 0x20 || r == 0x7f {
			return invalid(path, "control character in segment")
		}
	}
	if strings.HasSuffix(seg, ".") || strings.HasSuffix(seg, " ") {
		return invalid(path, "segment ends with dot or space: "+seg)
	}
	base := seg
	if i := strings.IndexByte(seg, '.'); i >= 0 {
		base = seg[:i]
	}
	if _, reserved := windowsReserved[strings.ToUpper(base)]; reserved {
		return invalid(path, "reserved name "+seg)
	}
	return nil
}

// Validate reports whether p is acceptable without returning its normal form.
func Validate(p string) error {
	_, err := Normalize(p)
	return err
}

var folder = cases.Fold()

// Key returns the case-insensitive identity of an already normalized path:
// NFC + Unicode case folding. Two paths with equal keys collide on
// case-insensitive file systems (macOS, Windows) and the server rejects the
// second one with PATH_COLLISION. Keys are opaque: never show them to users.
func Key(normalized string) string {
	return folder.String(norm.NFC.String(normalized))
}

// Split returns the directory part (without trailing slash, "" for the root)
// and the base name of a normalized path.
func Split(normalized string) (dir, base string) {
	i := strings.LastIndexByte(normalized, '/')
	if i < 0 {
		return "", normalized
	}
	return normalized[:i], normalized[i+1:]
}

// Ext returns the lower-cased extension of the base name including the dot,
// or "" when there is none. Dotfiles such as ".gitignore" have no extension.
func Ext(normalized string) string {
	_, base := Split(normalized)
	i := strings.LastIndexByte(base, '.')
	if i <= 0 {
		return ""
	}
	return strings.ToLower(base[i:])
}

// HasPrefix reports whether path lies inside the folder prefix (or equals it).
// Both arguments must be in the same form (both normalized paths, or both
// keys). An empty prefix denotes the vault root and matches everything.
func HasPrefix(path, prefix string) bool {
	if prefix == "" {
		return true
	}
	return path == prefix || strings.HasPrefix(path, prefix+"/")
}

// Rebase rewrites a path that lies under from so that it lies under to; ok is
// false when path is outside from. Used for move_prefix and for mounting a
// shared folder relative to its share root (to == "").
func Rebase(path, from, to string) (string, bool) {
	if !HasPrefix(path, from) {
		return "", false
	}
	rest := strings.TrimPrefix(path, from)
	rest = strings.TrimPrefix(rest, "/")
	switch {
	case to == "" && rest == "":
		return "", true
	case to == "":
		return rest, true
	case rest == "":
		return to, true
	default:
		return to + "/" + rest, true
	}
}

// ConfigDir is the per-vault configuration folder (the Obsidian ".obsidian" analogue).
const ConfigDir = ".memobrain"

// TrashDir is the optional in-vault trash folder.
const TrashDir = ".trash"

// IsExcluded reports whether a normalized path must never be synchronized
// (§3.4.2): OS junk files, temporary files, device-specific workspace layout,
// caches, snapshots and local databases. When excludeTrash is true the
// in-vault trash folder is excluded as well.
func IsExcluded(normalized string, excludeTrash bool) bool {
	dir, base := Split(normalized)
	switch base {
	case ".DS_Store", "Thumbs.db", "desktop.ini":
		return true
	}
	if strings.HasSuffix(strings.ToLower(base), ".tmp") {
		return true
	}
	// Staging files of atomic writes (vault.WriteFile): a crash can leave one behind
	// and it must never be synchronized, indexed or listed.
	if strings.HasPrefix(base, ".memobrain-tmp-") {
		return true
	}
	if excludeTrash && (normalized == TrashDir || strings.HasPrefix(normalized, TrashDir+"/")) {
		return true
	}
	if !HasPrefix(normalized, ConfigDir) {
		return false
	}
	// Inside .memobrain/: only user settings are synchronized (§3.4.6); everything
	// device-specific or derived stays local.
	for _, local := range []string{"cache", "snapshots"} {
		if HasPrefix(normalized, ConfigDir+"/"+local) {
			return true
		}
	}
	if dir == ConfigDir {
		switch {
		case strings.HasPrefix(base, "workspace") && strings.HasSuffix(base, ".json"):
			return true
		case base == "index.db", base == "sync.db", base == "app.db":
			return true
		case strings.HasSuffix(base, ".db-journal"), strings.HasSuffix(base, ".db-wal"), strings.HasSuffix(base, ".db-shm"):
			return true
		}
	}
	return false
}
