package syncproto

import (
	"errors"
	"fmt"
	"time"

	"memobrain/shared/hashing"
	"memobrain/shared/pathrules"
)

// OpKind is the kind of a commit operation or of a changelog entry.
type OpKind string

// Operation kinds. Create, Modify, Move, Delete and Restore are per-file and
// appear both in commits and in the changelog. MovePrefix is a commit-only
// folder rename, expanded by the server into per-file Move entries; it is
// not allowed on private vaults (§3.8.5).
const (
	OpCreate     OpKind = "create"
	OpModify     OpKind = "modify"
	OpMove       OpKind = "move"
	OpDelete     OpKind = "delete"
	OpRestore    OpKind = "restore"
	OpMovePrefix OpKind = "move_prefix"
)

// FileKind classifies a file by extension (files.kind in the schema). Private
// vaults always use KindOpaque because the server cannot see the path.
type FileKind string

// File kinds.
const (
	KindMarkdown   FileKind = "md"
	KindCanvas     FileKind = "canvas"
	KindBase       FileKind = "base"
	KindExcalidraw FileKind = "excalidraw"
	KindAttachment FileKind = "attachment"
	KindConfig     FileKind = "config"
	KindOther      FileKind = "other"
	KindOpaque     FileKind = "opaque"
)

// KindOf classifies a normalized clear-text path.
func KindOf(path string) FileKind {
	if pathrules.HasPrefix(path, pathrules.ConfigDir) {
		return KindConfig
	}
	switch pathrules.Ext(path) {
	case ".md", ".marp": // a Marp presentation is Markdown: 3-way merge, index, links (ADR-0047)
		return KindMarkdown
	case ".canvas":
		return KindCanvas
	case ".base":
		return KindBase
	case ".excalidraw":
		return KindExcalidraw
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".avif",
		".pdf",
		".mp3", ".wav", ".m4a", ".ogg", ".flac", ".webm", ".mp4", ".mov", ".mkv":
		return KindAttachment
	default:
		return KindOther
	}
}

// Op is one operation inside a commit (§3.5.3). Which fields are required
// depends on Op; Validate enforces the rules.
type Op struct {
	OpID   string `json:"op_id"`
	Op     OpKind `json:"op"`
	FileID string `json:"file_id,omitempty"`
	Path   string `json:"path,omitempty"`
	// PathKey is the "hmac1:" identity of Path in private vaults (ADR-0009).
	PathKey     string     `json:"path_key,omitempty"`
	BaseRev     *int       `json:"base_rev,omitempty"`
	BlobHash    string     `json:"blob_hash,omitempty"`
	Size        int64      `json:"size,omitempty"`
	ClientMtime *time.Time `json:"client_mtime,omitempty"`
	// ConflictOf marks a conflict copy: the file it was derived from.
	ConflictOf string `json:"conflict_of,omitempty"`
	// From and To are used by move_prefix only.
	From string `json:"from,omitempty"`
	To   string `json:"to,omitempty"`
}

// CommitRequest is the body of POST /vaults/{vid}/commit.
type CommitRequest struct {
	DeviceID string `json:"device_id"`
	Ops      []Op   `json:"ops"`
}

// MaxOpsPerCommit bounds the batch size (§3.7).
const MaxOpsPerCommit = 500

// DefaultMaxFileBytes is the largest file accepted when neither the system
// setting nor the Config Profile sets one (§3.4.2: 100 MB).
const DefaultMaxFileBytes int64 = 100 << 20

// OpStatus is the per-operation outcome of a commit.
type OpStatus string

// Operation outcomes.
const (
	StatusAccepted OpStatus = "accepted"
	StatusConflict OpStatus = "conflict"
	StatusRejected OpStatus = "rejected"
)

// OpResult is the outcome of one Op. Rev and Seq are set when accepted;
// Code/Detail when rejected; Code=REV_CONFLICT plus Current* when in conflict.
type OpResult struct {
	OpID        string   `json:"op_id"`
	Status      OpStatus `json:"status"`
	FileID      string   `json:"file_id,omitempty"`
	Rev         int      `json:"rev,omitempty"`
	Seq         int64    `json:"seq,omitempty"`
	Code        Code     `json:"code,omitempty"`
	Detail      string   `json:"detail,omitempty"`
	CurrentRev  int      `json:"current_rev,omitempty"`
	CurrentHash string   `json:"current_hash,omitempty"`
	CurrentSeq  int64    `json:"current_seq,omitempty"`
}

// CommitResponse is the body returned by POST /vaults/{vid}/commit.
type CommitResponse struct {
	Results []OpResult `json:"results"`
	LastSeq int64      `json:"last_seq"`
}

// Change is one changelog entry returned by GET /vaults/{vid}/changes.
type Change struct {
	Seq        int64     `json:"seq"`
	FileID     string    `json:"file_id"`
	Op         OpKind    `json:"op"`
	Path       string    `json:"path"`
	PrevPath   *string   `json:"prev_path"`
	Rev        int       `json:"rev"`
	BlobHash   *string   `json:"blob_hash"`
	Size       int64     `json:"size"`
	AuthorID   string    `json:"author_id"`
	DeviceID   *string   `json:"device_id"`
	ServerTime time.Time `json:"server_time"`
	ConflictOf *string   `json:"conflict_of,omitempty"`
}

// ChangesResponse is the body of GET /vaults/{vid}/changes.
type ChangesResponse struct {
	Items   []Change `json:"items"`
	NextSeq int64    `json:"next_seq"`
	HasMore bool     `json:"has_more"`
}

// TreeEntry is one current file in GET /vaults/{vid}/tree.
type TreeEntry struct {
	Path     string `json:"path"`
	FileID   string `json:"file_id"`
	Rev      int    `json:"rev"`
	BlobHash string `json:"blob_hash"`
	Size     int64  `json:"size"`
}

// TreeResponse is the body of GET /vaults/{vid}/tree.
type TreeResponse struct {
	Items   []TreeEntry `json:"items"`
	AsOfSeq int64       `json:"as_of_seq"`
}

// ErrInvalidOp wraps every validation error returned by Op.Validate.
var ErrInvalidOp = errors.New("invalid operation")

func opErr(op Op, msg string) error {
	return fmt.Errorf("%w %q (%s): %s", ErrInvalidOp, op.OpID, op.Op, msg)
}

// Validate checks structural rules that do not depend on vault state:
// required fields per kind, hash format and, for clear-text paths, path
// rules. opaquePaths must be true for private vaults, whose paths are
// "enc1:" or "enc2:" tokens validated only for shape (§3.8.5, ADR-0042).
func (o Op) Validate(opaquePaths bool) error {
	if o.OpID == "" {
		return opErr(o, "op_id is required")
	}
	checkPath := func(p, field string) error {
		if p == "" {
			return opErr(o, field+" is required")
		}
		if opaquePaths {
			if !IsOpaquePath(p) {
				return opErr(o, field+" must be an enc1: or enc2: token")
			}
			return nil
		}
		if err := pathrules.Validate(p); err != nil {
			return opErr(o, err.Error())
		}
		return nil
	}
	needBlob := func() error {
		if !hashing.IsHex(o.BlobHash) {
			return opErr(o, "blob_hash must be a sha256 hex string")
		}
		if o.Size < 0 {
			return opErr(o, "size must not be negative")
		}
		return nil
	}
	switch o.Op {
	case OpCreate:
		if o.FileID == "" {
			return opErr(o, "file_id is required")
		}
		if err := checkPath(o.Path, "path"); err != nil {
			return err
		}
		if o.BaseRev != nil {
			return opErr(o, "base_rev is not allowed on create")
		}
		return needBlob()
	case OpModify:
		if o.FileID == "" {
			return opErr(o, "file_id is required")
		}
		if o.BaseRev == nil {
			return opErr(o, "base_rev is required")
		}
		return needBlob()
	case OpMove:
		if o.FileID == "" {
			return opErr(o, "file_id is required")
		}
		if o.BaseRev == nil {
			return opErr(o, "base_rev is required")
		}
		return checkPath(o.Path, "path")
	case OpDelete, OpRestore:
		if o.FileID == "" {
			return opErr(o, "file_id is required")
		}
		if o.BaseRev == nil {
			return opErr(o, "base_rev is required")
		}
		return nil
	case OpMovePrefix:
		if opaquePaths {
			return opErr(o, "move_prefix is not supported on private vaults")
		}
		if err := checkPath(o.From, "from"); err != nil {
			return err
		}
		if err := checkPath(o.To, "to"); err != nil {
			return err
		}
		if o.From == o.To {
			return opErr(o, "from and to are equal")
		}
		if pathrules.HasPrefix(o.To, o.From) {
			return opErr(o, "to must not lie inside from")
		}
		return nil
	default:
		return opErr(o, "unknown op")
	}
}

// OpaquePathPrefix marks encrypted paths of private vaults (§3.8.3).
const OpaquePathPrefix = "enc1:"

// OpaquePathPrefixV2 marks encrypted paths bound to their vault and file
// (ADR-0042): same shape and the same hmac1 path key as enc1.
const OpaquePathPrefixV2 = "enc2:"

// MaxOpaquePathLen bounds the serialized encrypted path: base64url of
// nonce(12) + ciphertext(≤1024) + tag(16), plus the prefix (both prefixes
// have the same length).
const MaxOpaquePathLen = len(OpaquePathPrefix) + ((12+pathrules.MaxPathBytes+16)*4+2)/3 + 4

// IsOpaquePath reports whether p has the shape of an encrypted path token
// (either format).
func IsOpaquePath(p string) bool {
	if len(p) <= len(OpaquePathPrefix) || len(p) > MaxOpaquePathLen {
		return false
	}
	if pre := p[:len(OpaquePathPrefix)]; pre != OpaquePathPrefix && pre != OpaquePathPrefixV2 {
		return false
	}
	for _, c := range p[len(OpaquePathPrefix):] {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '-', c == '_':
		default:
			return false
		}
	}
	return true
}
