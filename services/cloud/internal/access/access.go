// Package access defines the vocabulary of authorization shared by the modules
// that serve vault content (sync, blobs, revisions, vaults): permission
// levels (§3.3.2), the scope of a share, and the Authorizer interface the
// sharing module implements. Modules depend on this interface, never on the
// share tables (§4.3).
package access

import (
	"context"
	"fmt"
	"path"
	"strings"

	"github.com/google/uuid"

	"clarae/services/cloud/internal/vaults/vaultsdb"
	"clarae/shared/pathrules"
)

// Permission is a level of access to a resource.
type Permission int

// Levels, from none to the owner of the vault.
const (
	None Permission = iota
	Viewer
	Editor
	Manager
	Owner
)

func (p Permission) String() string {
	switch p {
	case Viewer:
		return "viewer"
	case Editor:
		return "editor"
	case Manager:
		return "manager"
	case Owner:
		return "owner"
	default:
		return "none"
	}
}

// ParsePermission reads a grant level; unknown values are None.
func ParsePermission(s string) Permission {
	switch s {
	case "viewer":
		return Viewer
	case "editor":
		return Editor
	case "manager":
		return Manager
	case "owner":
		return Owner
	}
	return None
}

// CanWrite reports whether the level may create, change and delete files.
func (p Permission) CanWrite() bool { return p >= Editor }

// Share resource types.
const (
	ResourceVault  = "vault"
	ResourceFolder = "folder"
	ResourceFile   = "file"
)

// ScopePrefix introduces a share scope in query parameters: "share:<id>".
const ScopePrefix = "share:"

// ParseScope extracts the share id of a "share:<uuid>" scope.
func ParseScope(raw string) (uuid.UUID, bool) {
	rest, ok := strings.CutPrefix(raw, ScopePrefix)
	if !ok {
		return uuid.Nil, false
	}
	id, err := uuid.Parse(rest)
	return id, err == nil
}

// Scope is the part of a vault a share covers. Paths inside the mount are
// relative to its root.
type Scope struct {
	ShareID   uuid.UUID
	Type      string
	Prefix    string // folder shares, no trailing slash
	prefixKey string
	FileID    uuid.UUID // file shares
}

// NewScope builds the scope of a share: its id, resource type, folder prefix
// (folder shares) and file id (file shares).
func NewScope(shareID uuid.UUID, resourceType string, prefix *string, fileID *uuid.UUID) *Scope {
	sc := &Scope{ShareID: shareID, Type: resourceType}
	if prefix != nil {
		sc.Prefix = *prefix
		sc.prefixKey = pathrules.Key(sc.Prefix)
	}
	if fileID != nil {
		sc.FileID = *fileID
	}
	return sc
}

// ContainsPath reports whether a path (vault relative) lies inside the share.
// A file share is matched by file id, see ContainsFile.
func (s *Scope) ContainsPath(p string) bool {
	switch s.Type {
	case ResourceVault:
		return true
	case ResourceFolder:
		return strings.HasPrefix(pathrules.Key(p), s.prefixKey+"/")
	}
	return false
}

// ContainsFile reports whether a file lies inside the share.
func (s *Scope) ContainsFile(id uuid.UUID, p string) bool {
	if s.Type == ResourceFile {
		return id == s.FileID
	}
	return s.ContainsPath(p)
}

// ContainsScope reports whether the scope of another share of the same vault
// lies inside this one (ADR-0041 §8: a manager shares only inside the share
// they manage). A vault share contains everything; a folder share contains
// itself, its subfolders and the documents below it (compared by path_key, so
// case and Unicode normalization follow the rest of the scope code); a document
// share contains only a share of that same document. filePath is the current
// path of the inner document (file shares only).
func (s *Scope) ContainsScope(resourceType, prefix string, fileID uuid.UUID, filePath string) bool {
	switch s.Type {
	case ResourceVault:
		return true
	case ResourceFolder:
		switch resourceType {
		case ResourceFolder:
			k := pathrules.Key(prefix)
			return k == s.prefixKey || strings.HasPrefix(k, s.prefixKey+"/")
		case ResourceFile:
			return filePath != "" && s.ContainsPath(filePath)
		}
	case ResourceFile:
		return resourceType == ResourceFile && fileID == s.FileID
	}
	return false
}

// Rel converts a vault path to the path seen in the mount. A file share exposes
// its document under its base name.
func (s *Scope) Rel(p string) string {
	switch s.Type {
	case ResourceFolder:
		// Match by segments: a case-folded match may differ in byte length from the prefix.
		segs := strings.Split(p, "/")
		return strings.Join(segs[min(len(strings.Split(s.Prefix, "/")), len(segs)):], "/")
	case ResourceFile:
		return path.Base(p)
	}
	return p
}

// Abs converts a mount path to the vault path; it refuses anything that would
// leave the share.
func (s *Scope) Abs(rel string) (string, error) {
	norm, err := pathrules.Normalize(rel)
	if err != nil {
		return "", err
	}
	switch s.Type {
	case ResourceFolder:
		return s.Prefix + "/" + norm, nil
	case ResourceVault:
		return norm, nil
	}
	return "", fmt.Errorf("a document share has no paths to address")
}

// Projection is how one revision of a file appears through a share.
type Projection struct {
	Op       string
	Path     string  // relative to the root of the share
	PrevPath *string // set for a move inside the share
	// Content is false when the revision shows as a deletion (the file left
	// the share): its blob is not part of what the share exposes.
	Content bool
}

// Project translates a revision (file, operation, vault path and previous path)
// into what the share shows: paths relative to its root, a file moving out of
// the share as a delete and one moving in as a create. ok is false when the
// revision is invisible through the share (it happened outside it, or only
// moved a shared document between folders). Every reader of revisions through
// a share (changes, history, restore) goes through it, so their rules cannot
// drift apart.
func (s *Scope) Project(fileID uuid.UUID, op, p string, prev *string) (Projection, bool) {
	inNew := s.ContainsFile(fileID, p)
	inOld := prev != nil && s.ContainsFile(fileID, *prev)
	out := Projection{Op: op, Path: s.Rel(p), Content: true}
	if op != "move" {
		return out, inNew
	}
	switch {
	case inOld && inNew:
		if s.Type == ResourceFile && path.Base(p) == path.Base(*prev) {
			return Projection{}, false // a document moving between folders keeps its name in the mount
		}
		rel := s.Rel(*prev)
		out.PrevPath = &rel
	case inOld:
		// It left the share: to the recipient it is gone.
		out.Op, out.Path, out.Content = "delete", s.Rel(*prev), false
	case inNew:
		out.Op = "create" // it entered the share: where it came from is not shared
	default:
		return Projection{}, false
	}
	return out, true
}

// Vault is a vault row as the vaults module stores it. access is the shared
// vocabulary of the modules that serve vault content, so it names the type
// they pass around; it is the one place outside vaults that refers to vaultsdb
// (ADR-0033).
type Vault = vaultsdb.Vault

// Access is what an Authorizer grants for one request.
type Access struct {
	Vault Vault
	Perm  Permission
	// Scope is nil for the owner working on the whole vault.
	Scope *Scope
}

// Authorizer resolves whether a user may use a vault, optionally through a
// share ("share:<id>"), at the given level. Unknown, foreign and revoked
// resources are NOT_FOUND; an insufficient level on a visible one is FORBIDDEN.
type Authorizer interface {
	Authorize(ctx context.Context, userID, vaultID uuid.UUID, scope string, need Permission) (Access, error)
}
