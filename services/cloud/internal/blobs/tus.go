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
	"memobrain/services/cloud/internal/db"
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
// It is claimed first (uploads.finalizing_until, a lease): a request that
// arrives while another one finalizes waits for it and answers with the same
// outcome instead of assembling the chunks a second time.
//
// Chunk objects outlive their upload row only by accident (a crash between
// the steps, a row deleted with its vault): SweepOrphanChunks removes them.

const (
	tusVersion       = "1.0.0"
	maxPatchBytes    = 64 << 20
	defaultMaxUpload = 100 << 20
	// finalizeTimeout bounds the assembly of an upload (it no longer depends on the request).
	finalizeTimeout = 10 * time.Minute
	// finalizeLease is how long a claimed finalization keeps other requests
	// waiting: longer than finalizeTimeout, so it never ends while one runs.
	finalizeLease = finalizeTimeout + time.Minute
	// finalizePoll is how often a request waiting for another one's
	// finalization looks again.
	finalizePoll = 200 * time.Millisecond
	// cleanupBatch is the page size of the expired uploads cleanup.
	cleanupBatch = 200
	// sweepBatch is the number of chunk objects one existence check covers.
	sweepBatch = 500
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

// chunkKeys lists the objects holding the confirmed bytes of an upload, in
// order. An upload created before chunk_keys and resumed after the upgrade
// has its first chunks numbered (chunks counts them, chunk_keys does not)
// and the following ones in chunk_keys.
func chunkKeys(u blobsdb.Upload) []string {
	legacy := int(u.Chunks) - len(u.ChunkKeys)
	if legacy <= 0 {
		return u.ChunkKeys
	}
	keys := make([]string, 0, legacy+len(u.ChunkKeys))
	for i := int32(0); int(i) < legacy; i++ {
		keys = append(keys, legacyChunk(u.ID, i))
	}
	return append(keys, u.ChunkKeys...)
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
	ql, check, err := h.svc.quotaLimitOf(r.Context(), acc.Vault, length)
	if err != nil {
		problem(w, r, err)
		return
	}
	// The upload row reserves its length against the owner's quota until it
	// completes or expires: check and reserve atomically per owner.
	err = h.svc.db.WithTx(r.Context(), func(ctx context.Context, tx pgx.Tx) error {
		if check {
			if err := lockOwner(ctx, tx, acc.Vault.OwnerID); err != nil {
				return err
			}
			if err := h.svc.checkQuota(ctx, tx, acc.Vault, hash, length, noUpload, ql); err != nil {
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

// complete finalizes an upload whose bytes all arrived. It claims the
// finalization first; when another request holds the claim it waits for that
// one and reports its outcome (the vault holding the blob means success).
// The finalization itself runs detached from the request, with its own
// deadline. A permanent failure (digest mismatch, missing chunks, quota)
// discards the upload; a transient one keeps it for a retry (HEAD, or an
// empty PATCH at the final offset) and releases the claim.
func (h *TusHandler) complete(ctx context.Context, u blobsdb.Upload) error {
	q := blobsdb.New(h.svc.db.Pool)
	tick := time.NewTicker(finalizePoll)
	defer tick.Stop()
	for {
		n, err := q.ClaimUploadFinalization(context.WithoutCancel(ctx), blobsdb.ClaimUploadFinalizationParams{ID: u.ID, LeaseSeconds: finalizeLease.Seconds()})
		if err != nil {
			return err
		}
		if n == 1 {
			return h.finalizeClaimed(ctx, u)
		}
		// Another request is finalizing it, or did and dropped the upload.
		done, err := h.finalizedElsewhere(ctx, u)
		if done || err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-tick.C:
		}
	}
}

// finalizedElsewhere tells a request that could not claim the finalization
// whether it is over: done with nil when the vault has the blob, done with
// errChunkMissing when the upload was discarded without publishing it.
func (h *TusHandler) finalizedElsewhere(ctx context.Context, u blobsdb.Upload) (bool, error) {
	q := blobsdb.New(h.svc.db.Pool)
	// The upload first: a finalizer publishes the blob before it drops the upload.
	_, err := q.GetUpload(ctx, u.ID)
	gone := errors.Is(err, pgx.ErrNoRows)
	if err != nil && !gone {
		return false, err
	}
	has, err := q.VaultHasBlob(ctx, blobsdb.VaultHasBlobParams{VaultID: u.VaultID, Hash: u.ExpectedHash})
	switch {
	case err != nil:
		return false, err
	case has:
		return true, nil
	case gone:
		return true, errChunkMissing
	}
	return false, nil
}

// finalizeClaimed runs the finalization this request claimed.
func (h *TusHandler) finalizeClaimed(ctx context.Context, u blobsdb.Upload) error {
	fctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), finalizeTimeout)
	defer cancel()
	err := h.finalize(fctx, u)
	if err == nil {
		return nil
	}
	if errors.Is(err, errChunkMissing) {
		// A finalizer whose claim ran out (it died) may have published the
		// blob and deleted some chunks before dropping the upload.
		has, herr := blobsdb.New(h.svc.db.Pool).VaultHasBlob(fctx, blobsdb.VaultHasBlobParams{VaultID: u.VaultID, Hash: u.ExpectedHash})
		if herr == nil && has {
			return h.svc.dropUpload(fctx, u)
		}
	}
	var pe *httpproblem.Error
	if errors.As(err, &pe) {
		_ = h.svc.dropUpload(fctx, u)
	} else {
		// Not with fctx: a finalization that ran out of time must still let the
		// next retry in at once rather than after the rest of the lease.
		rctx, rcancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		_ = blobsdb.New(h.svc.db.Pool).ReleaseUploadFinalization(rctx, u.ID)
		rcancel()
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
	ql, check, err := h.svc.quotaLimitOf(ctx, v, u.Length)
	if err != nil {
		return err
	}
	if err := h.svc.ingestFile(ctx, v, u.ExpectedHash, f.Name(), u.Length, u.ID, ql, check); err != nil {
		return err
	}
	return h.svc.dropUpload(ctx, u)
}

// CleanupExpired removes expired upload sessions and their chunks (job). An
// upload that cannot be removed is skipped: the others still are, and the
// failures are reported at the end.
func (s *Service) CleanupExpired(ctx context.Context) (int, error) {
	q := blobsdb.New(s.db.Pool)
	var failed itemErrors
	n := 0
	for after := uuid.Nil; ; {
		rows, err := q.ListExpiredUploads(ctx, blobsdb.ListExpiredUploadsParams{After: after, MaxRows: cleanupBatch})
		if err != nil {
			return n, errors.Join(err, failed.err())
		}
		for _, u := range rows {
			if err := s.dropUpload(ctx, u); err != nil {
				if ctx.Err() != nil {
					return n, errors.Join(ctx.Err(), failed.err())
				}
				failed.add(fmt.Errorf("upload %s: %w", u.ID, err))
				continue
			}
			n++
		}
		if len(rows) < cleanupBatch {
			return n, failed.err()
		}
		after = rows[len(rows)-1].ID
	}
}

// UploadChunksOfVault lists, inside the transaction that deletes a vault, the
// chunk objects of the uploads in progress in it. The rows go with the vault
// (ON DELETE CASCADE); the caller deletes these objects once it committed.
func UploadChunksOfVault(ctx context.Context, tx db.DBTX, vaultID uuid.UUID) ([]string, error) {
	rows, err := blobsdb.New(tx).ListUploadsOfVault(ctx, vaultID)
	if err != nil {
		return nil, err
	}
	var keys []string
	for _, u := range rows {
		keys = append(keys, chunkKeys(u)...)
	}
	return keys, nil
}

// SweepOrphanChunks deletes the chunk objects (uploads/<upload id>/...) whose
// upload no longer exists and that are older than the upload expiry, as of
// now: what a crash between the steps left behind, or a deletion of the rows
// that did not reach the objects. The age spares the chunk of a PATCH in
// flight, which deletes its own object when the upload turns out to be gone.
// It returns the number of objects deleted; an object that cannot be deleted
// is skipped and reported at the end.
func (s *Service) SweepOrphanChunks(ctx context.Context, now time.Time) (int, error) {
	cutoff := now.Add(-s.UploadExpiry(ctx))
	type chunk struct {
		key string
		id  uuid.UUID
	}
	var (
		batch   []chunk
		failed  itemErrors
		deleted int
	)
	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		ids := make([]uuid.UUID, 0, len(batch))
		for _, c := range batch {
			ids = append(ids, c.id)
		}
		live, err := blobsdb.New(s.db.Pool).ListExistingUploads(ctx, ids)
		if err != nil {
			return err
		}
		exists := make(map[uuid.UUID]bool, len(live))
		for _, id := range live {
			exists[id] = true
		}
		for _, c := range batch {
			if exists[c.id] {
				continue
			}
			if err := s.store.Delete(ctx, c.key); err != nil {
				failed.add(fmt.Errorf("delete chunk %s: %w", c.key, err))
				continue
			}
			deleted++
		}
		batch = batch[:0]
		return nil
	}
	err := s.store.List(ctx, "uploads/", func(o storage.ObjectInfo) error {
		if !o.Modified.Before(cutoff) {
			return nil
		}
		dir, _, ok := strings.Cut(strings.TrimPrefix(o.Key, "uploads/"), "/")
		id, perr := uuid.Parse(dir)
		if !ok || perr != nil {
			return nil // not the chunk of an upload: not ours to delete
		}
		batch = append(batch, chunk{key: o.Key, id: id})
		if len(batch) >= sweepBatch {
			return flush()
		}
		return nil
	})
	if err == nil {
		err = flush()
	}
	return deleted, errors.Join(err, failed.err())
}

// itemErrors collects the failures of a job that skips the items it cannot
// process: every failure is counted, the first few are kept for the report.
type itemErrors struct {
	n     int
	first []error
}

func (e *itemErrors) add(err error) {
	e.n++
	if len(e.first) < 5 {
		e.first = append(e.first, err)
	}
}

func (e *itemErrors) err() error {
	if e.n == 0 {
		return nil
	}
	return fmt.Errorf("%d items failed: %w", e.n, errors.Join(e.first...))
}
