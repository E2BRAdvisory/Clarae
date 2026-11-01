package sync

import (
	"context"
	"io"
	"strings"

	"memobrain/apps/desktop/internal/sync/transport"
	"memobrain/shared/apiclient"
	"memobrain/shared/syncproto"
)

// Remote is the part of the cloud API the engine uses, for one vault.
type Remote interface {
	Tree(ctx context.Context) (transport.Tree, error)
	Changes(ctx context.Context, since int64, limit int) (transport.Changes, error)
	CheckBlobs(ctx context.Context, hashes []string) ([]string, error)
	// Upload stores a blob (single request up to 32 MB, resumable beyond).
	// resumeURL is the URL returned by an interrupted attempt; the returned
	// URL lets the caller persist progress.
	Upload(ctx context.Context, hash string, data []byte, resumeURL string) (string, error)
	Download(ctx context.Context, hash string, w io.Writer) error
	RevisionContent(ctx context.Context, fileID string, rev int, w io.Writer) error
	Commit(ctx context.Context, req syncproto.CommitRequest) (syncproto.CommitResponse, error)
}

// HTTPRemote implements Remote on transport.Client.
type HTTPRemote struct {
	C     *transport.Client
	Vault string
}

// Tree implements Remote.
func (r HTTPRemote) Tree(ctx context.Context) (transport.Tree, error) {
	return r.C.GetTree(ctx, r.Vault)
}

// Changes implements Remote.
func (r HTTPRemote) Changes(ctx context.Context, since int64, limit int) (transport.Changes, error) {
	return r.C.GetChanges(ctx, r.Vault, since, limit)
}

// CheckBlobs implements Remote.
func (r HTTPRemote) CheckBlobs(ctx context.Context, hashes []string) ([]string, error) {
	return r.C.CheckBlobs(ctx, r.Vault, hashes)
}

// Upload implements Remote.
func (r HTTPRemote) Upload(ctx context.Context, hash string, data []byte, resumeURL string) (string, error) {
	if len(data) <= transport.MaxSingleUpload {
		return "", r.C.PutBlob(ctx, r.Vault, hash, data)
	}
	return r.C.TusUpload(ctx, r.Vault, hash, data, resumeURL, nil)
}

// Download implements Remote.
func (r HTTPRemote) Download(ctx context.Context, hash string, w io.Writer) error {
	_, err := r.C.GetBlob(ctx, r.Vault, hash, w)
	return err
}

// RevisionContent implements Remote.
func (r HTTPRemote) RevisionContent(ctx context.Context, fileID string, rev int, w io.Writer) error {
	_, err := r.C.GetRevisionContent(ctx, r.Vault, fileID, rev, w)
	return err
}

// Commit implements Remote.
func (r HTTPRemote) Commit(ctx context.Context, req syncproto.CommitRequest) (syncproto.CommitResponse, error) {
	return r.C.Commit(ctx, r.Vault, req)
}

// FolderShareRoots implements FolderShareRooter: the path prefixes of the
// live folder shares of the vault, as its owner sees them. A mount (a vault
// reference with a share scope) has none of its own.
func (r HTTPRemote) FolderShareRoots(ctx context.Context) ([]string, error) {
	vault, scope, _ := strings.Cut(r.Vault, "|")
	if scope != "" {
		return nil, nil
	}
	shares, err := r.C.ListShares(ctx, "owned")
	if err != nil {
		return nil, err
	}
	var out []string
	for _, sh := range shares {
		if sh.VaultId.String() == vault && sh.ResourceType == apiclient.ResourceTypeFolder && sh.PathPrefix != nil && *sh.PathPrefix != "" {
			out = append(out, *sh.PathPrefix)
		}
	}
	return out, nil
}

// Cipher is the end-to-end encryption of a private vault, bound to its VMK.
// A nil Cipher means a shared vault: content and paths travel in clear.
type Cipher interface {
	// Locked reports that the VMK is not available (vault locked).
	Locked() bool
	// PathV2 reports whether new path tokens are written in format enc2
	// (ADR-0042, the Config Profile flag features.path_v2).
	PathV2() bool
	// EncryptPath returns the opaque token of the file's path, in format
	// enc2 (bound to the file) when v2 is set and enc1 otherwise, and the
	// uniqueness key (the same in both formats).
	EncryptPath(fileID, path string, v2 bool) (token, key string, err error)
	// DecryptFilePath opens the path token of a file, enc1 or enc2.
	DecryptFilePath(fileID, token string) (string, error)
	// DecryptPath opens an enc1 token, for callers that do not know the file
	// id; an enc2 token fails. Prefer DecryptFilePath.
	DecryptPath(token string) (string, error)
	EncryptBlob(fileID string, plaintext []byte) ([]byte, error)
	DecryptBlob(fileID string, blob []byte) ([]byte, error)
}
