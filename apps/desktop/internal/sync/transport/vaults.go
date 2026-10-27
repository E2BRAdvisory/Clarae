package transport

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/google/uuid"

	"memobrain/shared/syncproto"
)

// --- API types (mirror api/openapi.yaml) ----------------------------------

// Vault is a cloud vault.
type Vault struct {
	ID         string     `json:"id"`
	OwnerID    string     `json:"owner_id"`
	Name       string     `json:"name"`
	Kind       string     `json:"kind"` // private | shared
	LastSeq    int64      `json:"last_seq"`
	TotalBytes int64      `json:"total_bytes"`
	FileCount  int        `json:"file_count"`
	CreatedAt  time.Time  `json:"created_at"`
	DeletedAt  *time.Time `json:"deleted_at"`
}

// KDF is the "kdf" object of a key envelope.
type KDF struct {
	Alg  string `json:"alg"`
	T    uint32 `json:"t,omitempty"`
	MKiB uint32 `json:"m_kib,omitempty"`
	P    uint8  `json:"p,omitempty"`
	Salt string `json:"salt"`
}

// KeyEnvelope is a wrapped VMK; WrappedVMK is standard base64 on the wire
// (a []byte marshals exactly like that).
type KeyEnvelope struct {
	Kind       string    `json:"kind"`
	KDF        KDF       `json:"kdf"`
	WrappedVMK []byte    `json:"wrapped_vmk"`
	CreatedAt  time.Time `json:"created_at,omitempty"`
}

// TreeEntry is one current file of the manifest.
type TreeEntry struct {
	Path   string `json:"path"`
	FileID string `json:"file_id"`
	Rev    int    `json:"rev"`
	Hash   string `json:"hash"`
	Size   int64  `json:"size"`
	Kind   string `json:"kind"`
}

// Tree is GET /vaults/{id}/tree.
type Tree struct {
	Items   []TreeEntry `json:"items"`
	AsOfSeq int64       `json:"as_of_seq"`
}

// Change is one changelog entry.
type Change struct {
	Seq        int64     `json:"seq"`
	FileID     string    `json:"file_id"`
	Op         string    `json:"op"`
	Path       string    `json:"path"`
	PrevPath   string    `json:"prev_path"`
	Rev        int       `json:"rev"`
	BlobHash   string    `json:"blob_hash"`
	Size       int64     `json:"size"`
	AuthorID   string    `json:"author_id"`
	DeviceID   string    `json:"device_id"`
	ServerTime time.Time `json:"server_time"`
	ConflictOf string    `json:"conflict_of"`
}

// Changes is GET /vaults/{id}/changes.
type Changes struct {
	Items   []Change `json:"items"`
	NextSeq int64    `json:"next_seq"`
	HasMore bool     `json:"has_more"`
}

// Revision is one entry of a file's history.
type Revision struct {
	Rev        int       `json:"rev"`
	Seq        int64     `json:"seq"`
	Op         string    `json:"op"`
	Path       string    `json:"path"`
	PrevPath   string    `json:"prev_path"`
	BlobHash   string    `json:"blob_hash"`
	Size       int64     `json:"size"`
	AuthorID   string    `json:"author_id"`
	DeviceID   string    `json:"device_id"`
	ServerTime time.Time `json:"server_time"`
	ConflictOf string    `json:"conflict_of"`
}

// Usage is GET /me/usage.
type Usage struct {
	UsedBytes  int64  `json:"used_bytes"`
	QuotaBytes int64  `json:"quota_bytes"`
	Level      string `json:"level"`
}

// --- vaults ------------------------------------------------------------------

// CreateVault creates a vault; private vaults carry both key envelopes.
func (c *Client) CreateVault(ctx context.Context, name, kind string, envelopes []KeyEnvelope) (Vault, error) {
	body := map[string]any{"name": name, "kind": kind}
	if len(envelopes) > 0 {
		body["key_envelopes"] = envelopes
	}
	var out Vault
	err := c.Do(ctx, http.MethodPost, "/vaults", body, &out, true)
	return out, err
}

// ListVaults returns the caller's vaults.
func (c *Client) ListVaults(ctx context.Context) ([]Vault, error) {
	var out struct {
		Items []Vault `json:"items"`
	}
	err := c.Do(ctx, http.MethodGet, "/vaults", nil, &out, true)
	return out.Items, err
}

// GetVault returns one vault.
func (c *Client) GetVault(ctx context.Context, id string) (Vault, error) {
	var out Vault
	err := c.Do(ctx, http.MethodGet, "/vaults/"+id, nil, &out, true)
	return out, err
}

// DeleteVault soft-deletes a vault.
func (c *Client) DeleteVault(ctx context.Context, id string) error {
	return c.Do(ctx, http.MethodDelete, "/vaults/"+id, nil, nil, true)
}

// GetKeyEnvelopes returns the envelopes of a private vault.
func (c *Client) GetKeyEnvelopes(ctx context.Context, id string) ([]KeyEnvelope, error) {
	var out struct {
		Items []KeyEnvelope `json:"items"`
	}
	err := c.Do(ctx, http.MethodGet, "/vaults/"+id+"/key-envelopes", nil, &out, true)
	return out.Items, err
}

// PutKeyEnvelope replaces one envelope.
func (c *Client) PutKeyEnvelope(ctx context.Context, id string, env KeyEnvelope) error {
	return c.Do(ctx, http.MethodPut, "/vaults/"+id+"/key-envelopes/"+env.Kind, env, nil, true)
}

// GetTree returns the manifest.
func (c *Client) GetTree(ctx context.Context, ref string) (Tree, error) {
	id, scope := splitRef(ref)
	var out Tree
	err := c.Do(ctx, http.MethodGet, withScope("/vaults/"+id+"/tree", scope), nil, &out, true)
	return out, err
}

// GetChanges returns changelog entries after since. A cursor older than the
// compaction window yields an error matching CodeError(CURSOR_EXPIRED).
func (c *Client) GetChanges(ctx context.Context, ref string, since int64, limit int) (Changes, error) {
	id, scope := splitRef(ref)
	var out Changes
	q := url.Values{"since": {strconv.FormatInt(since, 10)}}
	if scope != "" {
		q.Set("scope", scope)
	}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	err := c.Do(ctx, http.MethodGet, "/vaults/"+id+"/changes?"+q.Encode(), nil, &out, true)
	return out, err
}

// CheckBlobs returns the hashes the server does not have.
func (c *Client) CheckBlobs(ctx context.Context, ref string, hashes []string) ([]string, error) {
	id, scope := splitRef(ref)
	var out struct {
		Missing []string `json:"missing"`
	}
	err := c.Do(ctx, http.MethodPost, withScope("/vaults/"+id+"/blobs:check", scope), map[string]any{"hashes": hashes}, &out, true)
	return out.Missing, err
}

// Commit sends a batch of operations.
func (c *Client) Commit(ctx context.Context, ref string, req syncproto.CommitRequest) (syncproto.CommitResponse, error) {
	id, scope := splitRef(ref)
	var out syncproto.CommitResponse
	err := c.Do(ctx, http.MethodPost, withScope("/vaults/"+id+"/commit", scope), req, &out, true)
	return out, err
}

// ListRevisions returns the history of a file, newest first.
func (c *Client) ListRevisions(ctx context.Context, ref, file string, limit int, cursor string) (items []Revision, next string, err error) {
	vault, scope := splitRef(ref)
	var out struct {
		Items      []Revision `json:"items"`
		NextCursor string     `json:"next_cursor"`
	}
	q := url.Values{}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	if cursor != "" {
		q.Set("cursor", cursor)
	}
	if scope != "" {
		q.Set("scope", scope)
	}
	err = c.Do(ctx, http.MethodGet, "/vaults/"+vault+"/files/"+file+"/revisions?"+q.Encode(), nil, &out, true)
	return out.Items, out.NextCursor, err
}

// RestoreRevision restores a revision as a new one.
func (c *Client) RestoreRevision(ctx context.Context, ref, file string, rev int) (syncproto.OpResult, error) {
	vault, scope := splitRef(ref)
	var out syncproto.OpResult
	err := c.Do(ctx, http.MethodPost, withScope(fmt.Sprintf("/vaults/%s/files/%s/revisions/%d:restore", vault, file, rev), scope), nil, &out, true)
	return out, err
}

// GetUsage returns the storage usage of the caller.
func (c *Client) GetUsage(ctx context.Context) (Usage, error) {
	var out Usage
	err := c.Do(ctx, http.MethodGet, "/me/usage", nil, &out, true)
	return out, err
}

// ListDevices returns the caller's active devices.
func (c *Client) ListDevices(ctx context.Context) ([]Device, error) {
	var out struct {
		Items []Device `json:"items"`
	}
	err := c.Do(ctx, http.MethodGet, "/me/devices", nil, &out, true)
	return out.Items, err
}

// RevokeDevice revokes a device.
func (c *Client) RevokeDevice(ctx context.Context, id string) error {
	return c.Do(ctx, http.MethodDelete, "/me/devices/"+id, nil, nil, true)
}

// --- binary transfers --------------------------------------------------------

// MaxSingleUpload is the largest blob sent with one PUT; bigger ones use tus.
const MaxSingleUpload = 32 << 20

// raw performs an authenticated request with a binary body or response,
// retrying like Do. body may be nil; for retries it must be re-readable, so
// only byte slices are accepted.
func (c *Client) raw(ctx context.Context, method, path string, body []byte, headers map[string]string) (*http.Response, error) {
	var lastErr error
	for attempt := 0; attempt <= c.Retries; attempt++ {
		if attempt > 0 {
			if err := sleepCtx(ctx, backoff(attempt, lastErr)); err != nil {
				return nil, err
			}
		}
		var rdr io.Reader
		if body != nil {
			rdr = bytes.NewReader(body)
		}
		req, err := http.NewRequestWithContext(ctx, method, c.base.String()+BasePath+path, rdr)
		if err != nil {
			return nil, err
		}
		req.Header.Set("User-Agent", c.userAgent)
		req.Header.Set("X-Request-Id", uuid.NewString())
		tok, err := c.tokens.Token(ctx)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+tok)
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		resp, err := c.http.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		if resp.StatusCode >= 500 || resp.StatusCode == http.StatusTooManyRequests {
			lastErr = decode(resp, nil)
			continue
		}
		return resp, nil
	}
	return nil, lastErr
}

// PutBlob uploads a blob of at most MaxSingleUpload bytes.
func (c *Client) PutBlob(ctx context.Context, ref, hash string, data []byte) error {
	vault, scope := splitRef(ref)
	if len(data) > MaxSingleUpload {
		return fmt.Errorf("blob of %d bytes needs a resumable upload", len(data))
	}
	resp, err := c.raw(ctx, http.MethodPut, withScope("/vaults/"+vault+"/blobs/"+hash, scope), data, map[string]string{"Content-Type": "application/octet-stream"})
	if err != nil {
		return err
	}
	return decode(resp, nil)
}

// GetBlob downloads a blob into w and returns its size.
func (c *Client) GetBlob(ctx context.Context, ref, hash string, w io.Writer) (int64, error) {
	vault, scope := splitRef(ref)
	resp, err := c.raw(ctx, http.MethodGet, withScope("/vaults/"+vault+"/blobs/"+hash, scope), nil, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 400 {
		return 0, decode(resp, nil)
	}
	return io.Copy(w, resp.Body)
}

// GetRevisionContent downloads the blob of a revision into w.
func (c *Client) GetRevisionContent(ctx context.Context, ref, file string, rev int, w io.Writer) (int64, error) {
	vault, scope := splitRef(ref)
	resp, err := c.raw(ctx, http.MethodGet, withScope(fmt.Sprintf("/vaults/%s/files/%s/revisions/%d/content", vault, file, rev), scope), nil, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 400 {
		return 0, decode(resp, nil)
	}
	return io.Copy(w, resp.Body)
}

// IsCode reports whether err is an API problem with the given code.
func IsCode(err error, code syncproto.Code) bool {
	var pe *ProblemError
	return errors.As(err, &pe) && pe.Problem.Code == code
}
