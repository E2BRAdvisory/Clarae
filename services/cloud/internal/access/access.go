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

	"memobrain/services/cloud/internal/vaults/vaultsdb"
	"memobrain/shared/pathrules"
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
