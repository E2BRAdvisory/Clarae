package sync

import (
	"context"
	"io"

	"nodus/apps/desktop/internal/sync/transport"
	"nodus/shared/syncproto"
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

// Cipher is the end-to-end encryption of a private vault, bound to its VMK.
// A nil Cipher means a shared vault: content and paths travel in clear.
type Cipher interface {
	// Locked reports that the VMK is not available (vault locked).
	Locked() bool
	// EncryptPath returns the opaque path token and the uniqueness key.
	EncryptPath(path string) (token, key string, err error)
	DecryptPath(token string) (string, error)
	EncryptBlob(fileID string, plaintext []byte) ([]byte, error)
	DecryptBlob(fileID string, blob []byte) ([]byte, error)
}
