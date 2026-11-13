package sync

import (
	"context"
	"errors"
	"io"
	"strings"

	"clarae/apps/desktop/internal/sync/transport"
	"clarae/shared/apiclient"
	"clarae/shared/syncproto"
)

// Remote is the part of the cloud API the engine uses, for one vault.
type Remote interface {
	Tree(ctx context.Context) (transport.Tree, error)
	// Changes reads the changelog after the cursor since; sinceID is the id of
	// the change at since ("" when unknown, ADR-0046).
	Changes(ctx context.Context, since int64, sinceID string, limit int) (transport.Changes, error)
	CheckBlobs(ctx context.Context, hashes []string) ([]string, error)
	// Upload stores a blob (single request up to 32 MB, resumable beyond).
	// resumeURL is the URL returned by an interrupted attempt; the returned
	// URL lets the caller persist progress.
	Upload(ctx context.Context, hash string, data []byte, resumeURL string) (string, error)
	Download(ctx context.Context, hash string, w io.Writer) error
	RevisionContent(ctx context.Context, fileID string, rev int, w io.Writer) error
	Commit(ctx context.Context, req syncproto.CommitRequest) (syncproto.CommitResponse, error)
}

// scopeNotFound is a NOT_FOUND answered for the whole vault reference, by the endpoints that
// read it as a whole (its tree and its changelog): the vault, or the share of a mount, is gone or
// is not the caller's. A NOT_FOUND of a blob or of a revision is about that content only (a file
// moved out of a share after the change was listed, a blob not uploaded yet) and stays an
// ordinary error.
type scopeNotFound struct{ err error }

func (e scopeNotFound) Error() string { return e.err.Error() }
func (e scopeNotFound) Unwrap() error { return e.err }

// isScopeNotFound reports whether a sync error is a scopeNotFound.
func isScopeNotFound(err error) bool {
	var s scopeNotFound
	return errors.As(err, &s)
}

func markScope(err error) error {
	if err != nil && transport.IsCode(err, syncproto.CodeNotFound) {
		return scopeNotFound{err: err}
	}
	return err
}

// scopedRemote marks the NOT_FOUND of the whole-vault endpoints (scopeNotFound); the manager
// wraps every engine's remote with it.
type scopedRemote struct{ Remote }

// scopedRooter is a scopedRemote over a remote that lists folder shares.
type scopedRooter struct {
	scopedRemote
	FolderShareRooter
}

func scoped(r Remote) Remote {
	if l, ok := r.(FolderShareRooter); ok {
		return scopedRooter{scopedRemote{r}, l}
	}
	return scopedRemote{r}
}

// Tree implements Remote.
func (r scopedRemote) Tree(ctx context.Context) (transport.Tree, error) {
	t, err := r.Remote.Tree(ctx)
	return t, markScope(err)
}

// Changes implements Remote.
func (r scopedRemote) Changes(ctx context.Context, since int64, sinceID string, limit int) (transport.Changes, error) {
	c, err := r.Remote.Changes(ctx, since, sinceID, limit)
	return c, markScope(err)
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
func (r HTTPRemote) Changes(ctx context.Context, since int64, sinceID string, limit int) (transport.Changes, error) {
	return r.C.GetChanges(ctx, r.Vault, since, sinceID, limit)
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
