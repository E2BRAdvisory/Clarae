package blobs

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"memobrain/services/cloud/internal/access"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"memobrain/services/cloud/internal/auth"
	"memobrain/services/cloud/internal/blobs/blobsdb"
	"memobrain/services/cloud/internal/httpproblem"
	"memobrain/services/cloud/internal/storage"
	"memobrain/services/cloud/internal/vaults"
	"memobrain/shared/syncproto"
)

// Resumable uploads (tus 1.0.0, creation and termination extensions) for
// blobs above MaxSingleUpload. Chunks are stored as separate objects so the
// upload survives a restart and works across replicas; when the last byte
// arrives the chunks are assembled, the SHA-256 is verified against the value
// announced at creation and only then is the blob published.
//
// A PATCH streams its chunk into an object of its own with no transaction open
// and no row locked (a slow client must not pin a database connection). The
// offset moves on only when a conditional update confirms the chunk and
// records its object (uploads.chunk_keys): of two concurrent PATCHes at the
// same offset one wins, the other deletes its object and is told the new
// offset, and nothing can overwrite a confirmed chunk.
// The finalization runs detached from the request (a client that gives up
// does not cancel it halfway); when it fails for a transient reason the
// upload is kept, and a HEAD or an empty PATCH at the final offset retries it.

const (
	tusVersion       = "1.0.0"
	maxPatchBytes    = 64 << 20
	defaultMaxUpload = 100 << 20
	// finalizeTimeout bounds the assembly of an upload (it no longer depends on the request).
	finalizeTimeout = 10 * time.Minute
)

// TusHandler serves the upload endpoints. Mount it with Mount.
type TusHandler struct {
	svc       *Service
	maxUpload func(ctx context.Context) int64
	expiry    func(ctx context.Context) time.Duration
}

// NewTusHandler creates the handler. maxUpload and expiry read the current
// system settings (files.max_size_bytes, uploads.expiry_hours).
func NewTusHandler(s *Service, maxUpload func(context.Context) int64, expiry func(context.Context) time.Duration) *TusHandler {
	if maxUpload == nil {
		maxUpload = func(context.Context) int64 { return defaultMaxUpload }
	}
	if expiry == nil {
		expiry = s.UploadExpiry
	}
	return &TusHandler{svc: s, maxUpload: maxUpload, expiry: expiry}
}

// Mount registers the routes below base ("/api/v1"). Authentication must wrap r.
func (h *TusHandler) Mount(r chi.Router, base string) {
	r.Options(base+"/vaults/{vaultId}/uploads", h.options)
	r.Options(base+"/uploads/{uploadId}", h.options)
	r.Post(base+"/vaults/{vaultId}/uploads", h.create)
	r.Head(base+"/uploads/{uploadId}", h.head)
	r.Patch(base+"/uploads/{uploadId}", h.patch)
	r.Delete(base+"/uploads/{uploadId}", h.terminate)
}

func tusHeaders(w http.ResponseWriter) {
	w.Header().Set("Tus-Resumable", tusVersion)
	w.Header().Set("Cache-Control", "no-store")
}

func (h *TusHandler) options(w http.ResponseWriter, _ *http.Request) {
	tusHeaders(w)
	w.Header().Set("Tus-Version", tusVersion)
	w.Header().Set("Tus-Extension", "creation,termination")
	w.Header().Set("Tus-Max-Size", strconv.FormatInt(h.maxUpload(context.Background()), 10))
	w.WriteHeader(http.StatusNoContent)
}

func problem(w http.ResponseWriter, r *http.Request, err error) {
	var pe *httpproblem.Error
	if errors.As(err, &pe) {
		httpproblem.Write(w, r, pe.Code, pe.Detail, pe.Extra)
		return
	}
	httpproblem.Write(w, r, syncproto.CodeInternal, "", nil)
}

func requireTus(w http.ResponseWriter, r *http.Request) bool {
	if r.Header.Get("Tus-Resumable") != tusVersion {
		tusHeaders(w)
		w.Header().Set("Tus-Version", tusVersion)
		httpproblem.Write(w, r, syncproto.CodeValidationFailed, "Tus-Resumable: "+tusVersion+" is required", nil)
		return false
	}
	return true
}

// metadata parses "Upload-Metadata: key base64, key2 base64".
func metadata(h string) map[string]string {
	out := map[string]string{}
	for _, part := range strings.Split(h, ",") {
		kv := strings.Fields(strings.TrimSpace(part))
		if len(kv) == 0 {
			continue
		}
		val := ""
		if len(kv) > 1 {
			if b, err := base64.StdEncoding.DecodeString(kv[1]); err == nil {
				val = string(b)
			}
		}
		out[kv[0]] = val
	}
	return out
}

// newChunkKey is the object a PATCH streams its chunk into.
func newChunkKey(id uuid.UUID) string { return "uploads/" + id.String() + "/" + uuid.NewString() }

// legacyChunk is the object of the n-th chunk of an upload created before
// chunk_keys existed (migration 0009).
func legacyChunk(id uuid.UUID, n int32) string { return fmt.Sprintf("uploads/%s/%08d", id, n) }

// errChunkMissing means the stored chunks do not add up to the confirmed
// offset: the upload cannot complete and must start over.
var errChunkMissing = httpproblem.Errorf(syncproto.CodeValidationFailed, "the upload is incomplete or corrupted: start it again")

// chunkKeys lists the objects holding the confirmed bytes of an upload, in order.
func chunkKeys(u blobsdb.Upload) []string {
	if len(u.ChunkKeys) > 0 || u.Chunks == 0 {
		return u.ChunkKeys
	}
	keys := make([]string, 0, u.Chunks)
	for i := int32(0); i < u.Chunks; i++ {
		keys = append(keys, legacyChunk(u.ID, i))
	}
	return keys
}

// dropUpload deletes the chunks of an upload, then its row. It is best effort
// on the objects (one left behind is harmless garbage); the error is the row's.
func (s *Service) dropUpload(ctx context.Context, u blobsdb.Upload) error {
	for _, k := range chunkKeys(u) {
		_ = s.store.Delete(ctx, k)
	}
	return blobsdb.New(s.db.Pool).DeleteUpload(ctx, u.ID)
}

func (h *TusHandler) create(w http.ResponseWriter, r *http.Request) {
	if !requireTus(w, r) {
		return
	}
	p := auth.MustPrincipal(r.Context())
	vid, err := uuid.Parse(chi.URLParam(r, "vaultId"))
	if err != nil {
		httpproblem.Write(w, r, syncproto.CodeNotFound, "vault not found", nil)
		return
	}
	acc, err := h.svc.authz.Authorize(r.Context(), p.UserID, vid, r.URL.Query().Get("scope"), access.Editor)
	if err != nil {
		problem(w, r, err)
		return
	}
	length, err := strconv.ParseInt(r.Header.Get("Upload-Length"), 10, 64)
	if err != nil || length <= 0 {
		httpproblem.Write(w, r, syncproto.CodeValidationFailed, "Upload-Length is required and must be positive", nil)
		return
	}
	if max := h.maxUpload(r.Context()); length > max {
		httpproblem.Write(w, r, syncproto.CodeFileTooLarge, fmt.Sprintf("upload larger than %d bytes", max), nil)
		return
	}
	hash := metadata(r.Header.Get("Upload-Metadata"))["sha256"]
	if !IsHash(hash) {
		httpproblem.Write(w, r, syncproto.CodeValidationFailed, "Upload-Metadata must carry sha256 (hex digest of the content)", nil)
		return
	}
	id, err := uuid.NewV7()
	if err != nil {
		problem(w, r, err)
		return
	}
	// The upload row reserves its length against the owner's quota until it
	// completes or expires: check and reserve atomically per owner.
	err = h.svc.db.WithTx(r.Context(), func(ctx context.Context, tx pgx.Tx) error {
		if h.svc.quota != nil {
			if err := lockOwner(ctx, tx, acc.Vault.OwnerID); err != nil {
				return err
			}
			if err := h.svc.checkQuota(ctx, tx, acc.Vault, hash, length, noUpload); err != nil {
				return err
			}
		}
		_, err := blobsdb.New(tx).CreateUpload(ctx, blobsdb.CreateUploadParams{
			ID: id, VaultID: vid, UserID: p.UserID, ExpectedHash: hash, Length: length,
			ExpiresAt: time.Now().Add(h.expiry(ctx)),
		})
		return err
	})
	if err != nil {
		problem(w, r, err)
		return
	}
	tusHeaders(w)
	w.Header().Set("Location", strings.TrimSuffix(r.URL.Path, "/vaults/"+vid.String()+"/uploads")+"/uploads/"+id.String())
	w.WriteHeader(http.StatusCreated)
}

// loadUpload fetches an upload owned by the caller; others get 404.
func (h *TusHandler) loadUpload(r *http.Request) (blobsdb.Upload, error) {
	id, err := uuid.Parse(chi.URLParam(r, "uploadId"))
	if err != nil {
		return blobsdb.Upload{}, httpproblem.NotFound("upload")
	}
	u, err := blobsdb.New(h.svc.db.Pool).GetUpload(r.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) {
		return blobsdb.Upload{}, httpproblem.NotFound("upload")
	}
	if err != nil {
		return blobsdb.Upload{}, err
	}
	if u.UserID != auth.MustPrincipal(r.Context()).UserID || time.Now().After(u.ExpiresAt) {
		return blobsdb.Upload{}, httpproblem.NotFound("upload")
	}
	return u, nil
}

func (h *TusHandler) head(w http.ResponseWriter, r *http.Request) {
	if !requireTus(w, r) {
		return
	}
	u, err := h.loadUpload(r)
	if err != nil {
		problem(w, r, err)
		return
	}
	if u.Received == u.Length {
		// Every byte arrived but the blob was not published (the finalization
		// failed or was interrupted): a client resuming here would commit next,
		// so the offset must not claim completion before the blob exists.
		if err := h.complete(r.Context(), u); err != nil {
			problem(w, r, err)
			return
		}
	}
	tusHeaders(w)
	w.Header().Set("Upload-Offset", strconv.FormatInt(u.Received, 10))
	w.Header().Set("Upload-Length", strconv.FormatInt(u.Length, 10))
	w.WriteHeader(http.StatusOK)
}

func (h *TusHandler) terminate(w http.ResponseWriter, r *http.Request) {
	if !requireTus(w, r) {
		return
	}
	u, err := h.loadUpload(r)
	if err != nil {
		problem(w, r, err)
		return
	}
	if err := h.svc.dropUpload(context.WithoutCancel(r.Context()), u); err != nil {
		problem(w, r, err)
		return
	}
	tusHeaders(w)
	w.WriteHeader(http.StatusNoContent)
}

func (h *TusHandler) patch(w http.ResponseWriter, r *http.Request) {
	if !requireTus(w, r) {
		return
	}
	if r.Header.Get("Content-Type") != "application/offset+octet-stream" {
		httpproblem.Write(w, r, syncproto.CodeValidationFailed, "Content-Type must be application/offset+octet-stream", nil)
		return
	}
	offset, err := strconv.ParseInt(r.Header.Get("Upload-Offset"), 10, 64)
	if err != nil || offset < 0 {
		httpproblem.Write(w, r, syncproto.CodeValidationFailed, "Upload-Offset is required", nil)
		return
	}
	u, err := h.loadUpload(r)
	if err != nil {
		problem(w, r, err)
		return
	}
	mismatch := func(server int64) {
		tusHeaders(w)
		w.Header().Set("Upload-Offset", strconv.FormatInt(server, 10))
		httpproblem.Write(w, r, syncproto.CodeValidationFailed, "Upload-Offset does not match the server offset", map[string]any{"offset": server})
	}
	if offset != u.Received {
		mismatch(u.Received)
		return
	}
	switch {
	case r.ContentLength == 0 && u.Received == u.Length:
		// An empty PATCH at the final offset retries a finalization that failed.
	case r.ContentLength <= 0 || r.ContentLength > maxPatchBytes:
		httpproblem.Write(w, r, syncproto.CodeValidationFailed, fmt.Sprintf("Content-Length must be 1..%d", maxPatchBytes), nil)
		return
	case u.Received+r.ContentLength > u.Length:
		httpproblem.Write(w, r, syncproto.CodeValidationFailed, "chunk exceeds the announced Upload-Length", nil)
		return
	default:
		// No transaction and no row lock while the body streams in.
		key := newChunkKey(u.ID)
		if err := h.svc.store.Put(r.Context(), key, r.Body, r.ContentLength); err != nil {
			_ = h.svc.store.Delete(context.WithoutCancel(r.Context()), key)
			problem(w, r, fmt.Errorf("store chunk: %w", err))
			return
		}
		n, err := blobsdb.New(h.svc.db.Pool).AdvanceUpload(r.Context(), blobsdb.AdvanceUploadParams{ID: u.ID, Size: r.ContentLength, FromOffset: offset, ChunkKey: key})
		if err != nil {
			_ = h.svc.store.Delete(context.WithoutCancel(r.Context()), key)
			problem(w, r, err)
			return
		}
		if n == 0 {
			// A concurrent PATCH confirmed this offset first (or the upload is gone).
			_ = h.svc.store.Delete(context.WithoutCancel(r.Context()), key)
			cur, err := h.loadUpload(r)
			if err != nil {
				problem(w, r, err)
				return
			}
			mismatch(cur.Received)
			return
		}
		u.Received += r.ContentLength
		u.Chunks++
		u.ChunkKeys = append(u.ChunkKeys, key)
	}
	if u.Received == u.Length {
		if err := h.complete(r.Context(), u); err != nil {
			problem(w, r, err)
			return
		}
	}
	tusHeaders(w)
	w.Header().Set("Upload-Offset", strconv.FormatInt(u.Received, 10))
	w.WriteHeader(http.StatusNoContent)
}

// complete finalizes an upload whose bytes all arrived. It runs detached from
// the request, with its own deadline. A permanent failure (digest mismatch,
// missing chunks, quota) discards the upload; a transient one keeps it for a
// retry (HEAD, or an empty PATCH at the final offset).
func (h *TusHandler) complete(ctx context.Context, u blobsdb.Upload) error {
	fctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), finalizeTimeout)
	defer cancel()
	err := h.finalize(fctx, u)
	if err == nil {
		return nil
	}
	var pe *httpproblem.Error
	if errors.As(err, &pe) {
		_ = h.svc.dropUpload(fctx, u)
	}
	return err
}

// finalize assembles the chunks into a temporary file, verifies the digest,
// publishes the blob and drops the upload.
func (h *TusHandler) finalize(ctx context.Context, u blobsdb.Upload) error {
	keys := chunkKeys(u)
	f, err := os.CreateTemp("", "memobrain-upload-*")
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(f.Name()) }()
	hasher := sha256.New()
	w := io.MultiWriter(f, hasher)
	var total int64
	for _, key := range keys {
		rc, err := h.svc.store.Get(ctx, key, 0, -1)
		if errors.Is(err, storage.ErrNotFound) {
			_ = f.Close()
			return errChunkMissing
		}
		if err != nil {
			_ = f.Close()
			return fmt.Errorf("read chunk %s: %w", key, err)
		}
		n, err := io.Copy(w, rc)
		_ = rc.Close()
		total += n
		if err != nil {
			_ = f.Close()
			return err
		}
	}
	if err := f.Close(); err != nil {
		return err
	}
	if total != u.Length {
		return errChunkMissing
	}
	if got := hex.EncodeToString(hasher.Sum(nil)); got != u.ExpectedHash {
		return httpproblem.Errorf(syncproto.CodeValidationFailed, "content hash %s does not match the announced %s", got, u.ExpectedHash)
	}
	v, err := vaults.GetVault(ctx, h.svc.db.Pool, u.VaultID)
	if err != nil {
		return err
	}
	if err := h.svc.ingestFile(ctx, v, u.ExpectedHash, f.Name(), u.Length, u.ID); err != nil {
		return err
	}
	return h.svc.dropUpload(ctx, u)
}

// CleanupExpired removes expired upload sessions and their chunks (job).
func (s *Service) CleanupExpired(ctx context.Context) (int, error) {
	rows, err := blobsdb.New(s.db.Pool).ListExpiredUploads(ctx, 200)
	if err != nil {
		return 0, err
	}
	for _, u := range rows {
		if err := s.dropUpload(ctx, u); err != nil {
			return 0, err
		}
	}
	return len(rows), nil
}
