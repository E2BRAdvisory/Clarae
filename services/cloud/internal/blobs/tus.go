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
	"memobrain/shared/syncproto"
)

// Resumable uploads (tus 1.0.0, creation and termination extensions) for
// blobs above MaxSingleUpload. Chunks are stored as separate objects so the
// upload survives a restart and works across replicas; when the last byte
// arrives the chunks are assembled, the SHA-256 is verified against the
// value announced at creation and only then is the blob published.

const (
	tusVersion       = "1.0.0"
	maxPatchBytes    = 64 << 20
	defaultMaxUpload = 100 << 20
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
		expiry = func(context.Context) time.Duration { return 24 * time.Hour }
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

func chunkKey(id uuid.UUID, n int32) string { return fmt.Sprintf("uploads/%s/%08d", id, n) }

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
	if _, err := h.svc.authz.Authorize(r.Context(), p.UserID, vid, r.URL.Query().Get("scope"), access.Editor); err != nil {
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
	_, err = blobsdb.New(h.svc.db.Pool).CreateUpload(r.Context(), blobsdb.CreateUploadParams{
		ID: id, VaultID: vid, UserID: p.UserID, ExpectedHash: hash, Length: length,
		ExpiresAt: time.Now().Add(h.expiry(r.Context())),
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
func (h *TusHandler) loadUpload(r *http.Request, q *blobsdb.Queries, forUpdate bool) (blobsdb.Upload, error) {
	id, err := uuid.Parse(chi.URLParam(r, "uploadId"))
	if err != nil {
		return blobsdb.Upload{}, httpproblem.NotFound("upload")
	}
	var u blobsdb.Upload
	if forUpdate {
		u, err = q.GetUploadForUpdate(r.Context(), id)
	} else {
		u, err = q.GetUpload(r.Context(), id)
	}
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
	u, err := h.loadUpload(r, blobsdb.New(h.svc.db.Pool), false)
	if err != nil {
		problem(w, r, err)
		return
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
	u, err := h.loadUpload(r, blobsdb.New(h.svc.db.Pool), false)
	if err != nil {
		problem(w, r, err)
		return
	}
	h.discard(r.Context(), u)
	tusHeaders(w)
	w.WriteHeader(http.StatusNoContent)
}

func (h *TusHandler) discard(ctx context.Context, u blobsdb.Upload) {
	for i := int32(0); i < u.Chunks; i++ {
		_ = h.svc.store.Delete(ctx, chunkKey(u.ID, i))
	}
	_ = blobsdb.New(h.svc.db.Pool).DeleteUpload(ctx, u.ID)
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
	if r.ContentLength <= 0 || r.ContentLength > maxPatchBytes {
		httpproblem.Write(w, r, syncproto.CodeValidationFailed, fmt.Sprintf("Content-Length must be 1..%d", maxPatchBytes), nil)
		return
	}

	// The row lock serializes concurrent PATCHes of the same upload.
	tx, err := h.svc.db.Pool.Begin(r.Context())
	if err != nil {
		problem(w, r, err)
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	q := blobsdb.New(tx)
	u, err := h.loadUpload(r, q, true)
	if err != nil {
		problem(w, r, err)
		return
	}
	if offset != u.Received {
		tusHeaders(w)
		w.Header().Set("Upload-Offset", strconv.FormatInt(u.Received, 10))
		httpproblem.Write(w, r, syncproto.CodeValidationFailed, "Upload-Offset does not match the server offset", map[string]any{"offset": u.Received})
		return
	}
	if u.Received+r.ContentLength > u.Length {
		httpproblem.Write(w, r, syncproto.CodeValidationFailed, "chunk exceeds the announced Upload-Length", nil)
		return
	}
	if err := h.svc.store.Put(r.Context(), chunkKey(u.ID, u.Chunks), r.Body, r.ContentLength); err != nil {
		problem(w, r, fmt.Errorf("store chunk: %w", err))
		return
	}
	if err := q.AdvanceUpload(r.Context(), blobsdb.AdvanceUploadParams{ID: u.ID, Received: r.ContentLength}); err != nil {
		problem(w, r, err)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		problem(w, r, err)
		return
	}
	u.Received += r.ContentLength
	u.Chunks++

	if u.Received == u.Length {
		if err := h.finalize(r.Context(), u); err != nil {
			h.discard(r.Context(), u)
			problem(w, r, err)
			return
		}
	}
	tusHeaders(w)
	w.Header().Set("Upload-Offset", strconv.FormatInt(u.Received, 10))
	w.WriteHeader(http.StatusNoContent)
}

// finalize assembles the chunks into a temporary file, verifies the digest
// and publishes the blob.
func (h *TusHandler) finalize(ctx context.Context, u blobsdb.Upload) error {
	f, err := os.CreateTemp("", "memobrain-upload-*")
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(f.Name()) }()
	hasher := sha256.New()
	w := io.MultiWriter(f, hasher)
	for i := int32(0); i < u.Chunks; i++ {
		rc, err := h.svc.store.Get(ctx, chunkKey(u.ID, i), 0, -1)
		if err != nil {
			_ = f.Close()
			return fmt.Errorf("read chunk %d: %w", i, err)
		}
		_, err = io.Copy(w, rc)
		_ = rc.Close()
		if err != nil {
			_ = f.Close()
			return err
		}
	}
	if err := f.Close(); err != nil {
		return err
	}
	if got := hex.EncodeToString(hasher.Sum(nil)); got != u.ExpectedHash {
		return httpproblem.Errorf(syncproto.CodeValidationFailed, "content hash %s does not match the announced %s", got, u.ExpectedHash)
	}
	if err := h.svc.ingestFile(ctx, u.VaultID, u.ExpectedHash, f.Name(), u.Length); err != nil {
		return err
	}
	h.discard(ctx, u)
	return nil
}

// CleanupExpired removes expired upload sessions and their chunks (job).
func (s *Service) CleanupExpired(ctx context.Context) (int, error) {
	q := blobsdb.New(s.db.Pool)
	rows, err := q.ListExpiredUploads(ctx, 200)
	if err != nil {
		return 0, err
	}
	for _, u := range rows {
		for i := int32(0); i < u.Chunks; i++ {
			_ = s.store.Delete(ctx, chunkKey(u.ID, i))
		}
		if err := q.DeleteUpload(ctx, u.ID); err != nil {
			return 0, err
		}
	}
	return len(rows), nil
}
