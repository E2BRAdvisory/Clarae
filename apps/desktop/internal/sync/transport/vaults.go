package transport

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"time"

	"memobrain/shared/apiclient"
	"memobrain/shared/syncproto"
)

// API types of the vault endpoints (generated from api/openapi.yaml).
type (
	// Vault is a cloud vault; DeletedAt is set on a soft-deleted one.
	Vault = apiclient.Vault
	// KeyEnvelope is a wrapped VMK of a private vault; WrappedVmk travels as
	// standard base64 (a []byte marshals exactly like that).
	KeyEnvelope = apiclient.KeyEnvelope
	// KDF is the "kdf" object of a key envelope.
	KDF = apiclient.KdfParams
)

// --- sync payloads as the engine sees them ----------------------------------------
//
// The engine keeps file ids and paths as strings (sync.db) and treats absent
// optional fields as zero values, so the changelog, manifest and history are
// converted from the generated types instead of being exposed as they are.
// Change is also the format of the remote changes parked in sync.db
// (pending_remote), hence its JSON tags: keep them stable.

// TreeEntry is one current file of the manifest.
type TreeEntry struct {
	Path   string
	FileID string
	Rev    int
	Hash   string
	Size   int64
	Kind   string
}

// Tree is GET /vaults/{id}/tree.
type Tree struct {
	Items   []TreeEntry
	AsOfSeq int64
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
	Items   []Change
	NextSeq int64
	HasMore bool
}

// Revision is one entry of a file's history.
type Revision struct {
	Rev        int
	Seq        int64
	Op         string
	Path       string
	PrevPath   string
	BlobHash   string
	Size       int64
	AuthorID   string
	DeviceID   string
	ServerTime time.Time
	ConflictOf string
}

func changeFromAPI(c apiclient.Change) Change {
	return Change{
		Seq: c.Seq, FileID: c.FileId.String(), Op: string(c.Op), Path: c.Path, PrevPath: deref(c.PrevPath),
		Rev: c.Rev, BlobHash: deref(c.BlobHash), Size: c.Size, AuthorID: c.AuthorId.String(),
		DeviceID: idString(c.DeviceId), ServerTime: c.ServerTime, ConflictOf: idString(c.ConflictOf),
	}
}

func revisionFromAPI(r apiclient.Revision) Revision {
	return Revision{
		Rev: r.Rev, Seq: r.Seq, Op: string(r.Op), Path: r.Path, PrevPath: deref(r.PrevPath),
		BlobHash: deref(r.BlobHash), Size: r.Size, AuthorID: r.AuthorId.String(),
		DeviceID: idString(r.DeviceId), ServerTime: r.ServerTime, ConflictOf: idString(r.ConflictOf),
	}
}

func envelopeInput(e KeyEnvelope) apiclient.KeyEnvelopeInput {
	return apiclient.KeyEnvelopeInput{Kind: e.Kind, Kdf: e.Kdf, WrappedVmk: e.WrappedVmk}
}

// --- vaults ------------------------------------------------------------------

// CreateVault creates a vault; private vaults carry both key envelopes.
func (c *Client) CreateVault(ctx context.Context, name, kind string, envelopes []KeyEnvelope) (Vault, error) {
	body := apiclient.CreateVault{Name: name, Kind: apiclient.VaultKind(kind)}
	if len(envelopes) > 0 {
		in := make([]apiclient.KeyEnvelopeInput, 0, len(envelopes))
		for _, e := range envelopes {
			in = append(in, envelopeInput(e))
		}
		body.KeyEnvelopes = &in
	}
	res, err := c.api.CreateVaultWithResponse(ctx, &apiclient.CreateVaultParams{IdempotencyKey: idempotencyKey()}, body)
	if err != nil {
		return Vault{}, err
	}
	return want(res.HTTPResponse, res.Body, res.JSON201)
}

// ListVaults returns the caller's vaults (not the soft-deleted ones).
func (c *Client) ListVaults(ctx context.Context) ([]Vault, error) {
	return c.listVaults(ctx, false)
}

// ListDeletedVaults returns the caller's soft-deleted vaults that can still be
// restored with RestoreVault (deleted within the server's retention period).
func (c *Client) ListDeletedVaults(ctx context.Context) ([]Vault, error) {
	all, err := c.listVaults(ctx, true)
	if err != nil {
		return nil, err
	}
	out := make([]Vault, 0, len(all))
	for _, v := range all {
		if v.DeletedAt != nil {
			out = append(out, v)
		}
	}
	return out, nil
}

func (c *Client) listVaults(ctx context.Context, includeDeleted bool) ([]Vault, error) {
	params := &apiclient.ListVaultsParams{}
	if includeDeleted {
		params.IncludeDeleted = &includeDeleted
	}
	res, err := c.api.ListVaultsWithResponse(ctx, params)
	if err != nil {
		return nil, err
	}
	list, err := want(res.HTTPResponse, res.Body, res.JSON200)
	return list.Items, err
}

// GetVault returns one vault.
func (c *Client) GetVault(ctx context.Context, id string) (Vault, error) {
	vid, err := parseID("vault", id)
	if err != nil {
		return Vault{}, err
	}
	res, err := c.api.GetVaultWithResponse(ctx, vid)
	if err != nil {
		return Vault{}, err
	}
	return want(res.HTTPResponse, res.Body, res.JSON200)
}

// RenameVault renames a vault (owner). A name already used by another of the
// owner's vaults yields an error matching CodeError(NAME_IN_USE).
func (c *Client) RenameVault(ctx context.Context, id, name string) (Vault, error) {
	vid, err := parseID("vault", id)
	if err != nil {
		return Vault{}, err
	}
	res, err := c.api.UpdateVaultWithResponse(ctx, vid, apiclient.UpdateVault{Name: name})
	if err != nil {
		return Vault{}, err
	}
	return want(res.HTTPResponse, res.Body, res.JSON200)
}

// DeleteVault soft-deletes a vault (owner): the server keeps it, restorable
// with RestoreVault, for the retention period and purges it afterwards.
func (c *Client) DeleteVault(ctx context.Context, id string) error {
	vid, err := parseID("vault", id)
	if err != nil {
		return err
	}
	res, err := c.api.DeleteVaultWithResponse(ctx, vid)
	if err != nil {
		return err
	}
	return ok(res.HTTPResponse, res.Body)
}

// RestoreVault undoes a soft delete within the retention period (owner). A
// vault past it, or not the caller's, yields NOT_FOUND; a name taken in the
// meantime yields NAME_IN_USE (rename the other vault first).
func (c *Client) RestoreVault(ctx context.Context, id string) (Vault, error) {
	vid, err := parseID("vault", id)
	if err != nil {
		return Vault{}, err
	}
	res, err := c.api.RestoreVaultWithResponse(ctx, vid)
	if err != nil {
		return Vault{}, err
	}
	return want(res.HTTPResponse, res.Body, res.JSON200)
}

// GetKeyEnvelopes returns the envelopes of a private vault.
func (c *Client) GetKeyEnvelopes(ctx context.Context, id string) ([]KeyEnvelope, error) {
	vid, err := parseID("vault", id)
	if err != nil {
		return nil, err
	}
	res, err := c.api.GetKeyEnvelopesWithResponse(ctx, vid)
	if err != nil {
		return nil, err
	}
	list, err := want(res.HTTPResponse, res.Body, res.JSON200)
	return list.Items, err
}

// PutKeyEnvelope replaces one envelope (its Kind selects which).
func (c *Client) PutKeyEnvelope(ctx context.Context, id string, env KeyEnvelope) error {
	vid, err := parseID("vault", id)
	if err != nil {
		return err
	}
	res, err := c.api.PutKeyEnvelopeWithResponse(ctx, vid, env.Kind, envelopeInput(env))
	if err != nil {
		return err
	}
	_, err = want(res.HTTPResponse, res.Body, res.JSON200)
	return err
}

// --- sync --------------------------------------------------------------------

// GetTree returns the manifest.
func (c *Client) GetTree(ctx context.Context, ref string) (Tree, error) {
	vid, scope, err := vaultRef(ref)
	if err != nil {
		return Tree{}, err
	}
	res, err := c.api.GetVaultTreeWithResponse(ctx, vid, &apiclient.GetVaultTreeParams{Scope: scope})
	if err != nil {
		return Tree{}, err
	}
	t, err := want(res.HTTPResponse, res.Body, res.JSON200)
	if err != nil {
		return Tree{}, err
	}
	out := Tree{AsOfSeq: t.AsOfSeq, Items: make([]TreeEntry, 0, len(t.Items))}
	for _, e := range t.Items {
		out.Items = append(out.Items, TreeEntry{Path: e.Path, FileID: e.FileId.String(), Rev: e.Rev, Hash: e.Hash, Size: e.Size, Kind: e.Kind})
	}
	return out, nil
}

// GetChanges returns changelog entries after since. A cursor older than the
// compaction window yields an error matching CodeError(CURSOR_EXPIRED).
func (c *Client) GetChanges(ctx context.Context, ref string, since int64, limit int) (Changes, error) {
	vid, scope, err := vaultRef(ref)
	if err != nil {
		return Changes{}, err
	}
	res, err := c.api.GetChangesWithResponse(ctx, vid, &apiclient.GetChangesParams{Since: since, Limit: ptrIf(limit), Scope: scope})
	if err != nil {
		return Changes{}, err
	}
	page, err := want(res.HTTPResponse, res.Body, res.JSON200)
	if err != nil {
		return Changes{}, err
	}
	out := Changes{NextSeq: page.NextSeq, HasMore: page.HasMore, Items: make([]Change, 0, len(page.Items))}
	for _, ch := range page.Items {
		out.Items = append(out.Items, changeFromAPI(ch))
	}
	return out, nil
}

// CheckBlobs returns the hashes the server does not have.
func (c *Client) CheckBlobs(ctx context.Context, ref string, hashes []string) ([]string, error) {
	vid, scope, err := vaultRef(ref)
	if err != nil {
		return nil, err
	}
	res, err := c.api.CheckBlobsWithResponse(ctx, vid, &apiclient.CheckBlobsParams{Scope: scope}, apiclient.BlobCheck{Hashes: hashes})
	if err != nil {
		return nil, err
	}
	r, err := want(res.HTTPResponse, res.Body, res.JSON200)
	return r.Missing, err
}

// Commit sends a batch of operations. Retries reuse one Idempotency-Key.
func (c *Client) Commit(ctx context.Context, ref string, req syncproto.CommitRequest) (syncproto.CommitResponse, error) {
	vid, scope, err := vaultRef(ref)
	if err != nil {
		return syncproto.CommitResponse{}, err
	}
	body, err := commitToAPI(req)
	if err != nil {
		return syncproto.CommitResponse{}, err
	}
	res, err := c.api.CommitWithResponse(ctx, vid, &apiclient.CommitParams{Scope: scope, IdempotencyKey: idempotencyKey()}, body)
	if err != nil {
		return syncproto.CommitResponse{}, err
	}
	r, err := want(res.HTTPResponse, res.Body, res.JSON200)
	if err != nil {
		return syncproto.CommitResponse{}, err
	}
	out := syncproto.CommitResponse{LastSeq: r.LastSeq, Results: make([]syncproto.OpResult, 0, len(r.Results))}
	for _, o := range r.Results {
		out.Results = append(out.Results, opResultFromAPI(o))
	}
	return out, nil
}

func commitToAPI(req syncproto.CommitRequest) (apiclient.CommitRequest, error) {
	dev, err := parseID("device", req.DeviceID)
	if err != nil {
		return apiclient.CommitRequest{}, err
	}
	out := apiclient.CommitRequest{DeviceId: dev, Ops: make([]apiclient.CommitOp, 0, len(req.Ops))}
	for _, o := range req.Ops {
		opID, err := parseID("operation", o.OpID)
		if err != nil {
			return apiclient.CommitRequest{}, err
		}
		op := apiclient.CommitOp{
			OpId: opID, Op: apiclient.CommitOpKind(o.Op), Path: ptrIf(o.Path), PathKey: ptrIf(o.PathKey),
			BaseRev: o.BaseRev, BlobHash: ptrIf(o.BlobHash), Size: ptrIf(o.Size), ClientMtime: o.ClientMtime,
			From: ptrIf(o.From), To: ptrIf(o.To),
		}
		if o.FileID != "" {
			id, err := parseID("file", o.FileID)
			if err != nil {
				return apiclient.CommitRequest{}, err
			}
			op.FileId = &id
		}
		if o.ConflictOf != "" {
			id, err := parseID("file", o.ConflictOf)
			if err != nil {
				return apiclient.CommitRequest{}, err
			}
			op.ConflictOf = &id
		}
		out.Ops = append(out.Ops, op)
	}
	return out, nil
}

func opResultFromAPI(o apiclient.OpResult) syncproto.OpResult {
	r := syncproto.OpResult{
		OpID: o.OpId.String(), Status: syncproto.OpStatus(o.Status), FileID: idString(o.FileId),
		Rev: deref(o.Rev), Seq: deref(o.Seq), Detail: deref(o.Detail),
		CurrentRev: deref(o.CurrentRev), CurrentHash: deref(o.CurrentHash), CurrentSeq: deref(o.CurrentSeq),
	}
	if o.Code != nil {
		r.Code = syncproto.Code(*o.Code)
	}
	return r
}

// --- history -----------------------------------------------------------------

// ListRevisions returns the history of a file, newest first.
func (c *Client) ListRevisions(ctx context.Context, ref, file string, limit int, cursor string) (items []Revision, next string, err error) {
	vid, scope, err := vaultRef(ref)
	if err != nil {
		return nil, "", err
	}
	fid, err := parseID("file", file)
	if err != nil {
		return nil, "", err
	}
	res, err := c.api.ListRevisionsWithResponse(ctx, vid, fid, &apiclient.ListRevisionsParams{Scope: scope, Limit: ptrIf(limit), Cursor: ptrIf(cursor)})
	if err != nil {
		return nil, "", err
	}
	list, err := want(res.HTTPResponse, res.Body, res.JSON200)
	if err != nil {
		return nil, "", err
	}
	items = make([]Revision, 0, len(list.Items))
	for _, r := range list.Items {
		items = append(items, revisionFromAPI(r))
	}
	return items, deref(list.NextCursor), nil
}

// RestoreRevision restores a revision as a new one. Retries reuse one Idempotency-Key.
func (c *Client) RestoreRevision(ctx context.Context, ref, file string, rev int) (syncproto.OpResult, error) {
	vid, scope, err := vaultRef(ref)
	if err != nil {
		return syncproto.OpResult{}, err
	}
	fid, err := parseID("file", file)
	if err != nil {
		return syncproto.OpResult{}, err
	}
	res, err := c.api.RestoreRevisionWithResponse(ctx, vid, fid, rev, &apiclient.RestoreRevisionParams{Scope: scope, IdempotencyKey: idempotencyKey()})
	if err != nil {
		return syncproto.OpResult{}, err
	}
	r, err := want(res.HTTPResponse, res.Body, res.JSON200)
	if err != nil {
		return syncproto.OpResult{}, err
	}
	return opResultFromAPI(r), nil
}

// --- binary transfers --------------------------------------------------------

// MaxSingleUpload is the largest blob sent with one PUT; bigger ones use tus.
const MaxSingleUpload = 32 << 20

// PutBlob uploads a blob of at most MaxSingleUpload bytes.
func (c *Client) PutBlob(ctx context.Context, ref, hash string, data []byte) error {
	if len(data) > MaxSingleUpload {
		return fmt.Errorf("blob of %d bytes needs a resumable upload", len(data))
	}
	vid, scope, err := vaultRef(ref)
	if err != nil {
		return err
	}
	res, err := c.api.PutBlobWithBodyWithResponse(transfer(ctx), vid, hash, &apiclient.PutBlobParams{Scope: scope}, "application/octet-stream", bytes.NewReader(data))
	if err != nil {
		return err
	}
	return ok(res.HTTPResponse, res.Body)
}

// GetBlob downloads a blob into w and returns its size.
func (c *Client) GetBlob(ctx context.Context, ref, hash string, w io.Writer) (int64, error) {
	vid, scope, err := vaultRef(ref)
	if err != nil {
		return 0, err
	}
	resp, err := c.api.GetBlob(transfer(ctx), vid, hash, &apiclient.GetBlobParams{Scope: scope}, acceptBinary)
	if err != nil {
		return 0, err
	}
	return copyBody(resp, w)
}

// GetRevisionContent downloads the blob of a revision into w.
func (c *Client) GetRevisionContent(ctx context.Context, ref, file string, rev int, w io.Writer) (int64, error) {
	vid, scope, err := vaultRef(ref)
	if err != nil {
		return 0, err
	}
	fid, err := parseID("file", file)
	if err != nil {
		return 0, err
	}
	resp, err := c.api.GetRevisionContent(transfer(ctx), vid, fid, rev, &apiclient.GetRevisionContentParams{Scope: scope}, acceptBinary)
	if err != nil {
		return 0, err
	}
	return copyBody(resp, w)
}

// acceptBinary asks for the content (or a problem document) of a download.
func acceptBinary(_ context.Context, req *http.Request) error {
	req.Header.Set("Accept", "application/octet-stream, application/problem+json")
	return nil
}

// copyBody streams a download into w, or decodes its problem.
func copyBody(resp *http.Response, w io.Writer) (int64, error) {
	if resp.StatusCode >= 400 {
		return 0, decodeProblem(resp)
	}
	defer func() { _ = resp.Body.Close() }()
	return io.Copy(w, resp.Body)
}
