// Package blobs owns the content-addressed store: the blobs and vault_blobs
// tables, upload of blobs up to 32 MB and resumable tus uploads for larger
// ones, download with Range, and reference counting (M2-WP1).
//
// A blob is stored once per hash but a vault can only read or reference blobs
// it uploaded itself (vault_blobs): that keeps "blobs:check" from revealing
// what other users store and makes knowing a hash worthless without the bytes.
//
// Upload quota. D-03 charges the owner only for current files, at commit; the
// bytes uploaded but not committed yet are "pending": blobs linked to one of
// the owner's vaults within uploads.expiry_hours that no revision references,
// plus the announced length of the resumable uploads in progress. An upload
// is refused with QUOTA_EXCEEDED when used + pending + its size would exceed
// the owner's quota: before anything reaches the object store (PUT once the
// body is hashed, tus at creation) and again, atomically per owner, when the
// blob is linked to the vault. Pending bytes are never added to used_bytes:
// they stop counting when a commit references the blob (then used_bytes pays
// for it) or when the window ends (the blob is then the garbage collector's,
// after blobs.gc_grace_hours). So uncommitted uploads are never free storage
// beyond the remaining quota, and committing or deleting files works as before.
package blobs

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	"memobrain/services/cloud/internal/access"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"memobrain/services/cloud/internal/blobs/blobsdb"
	"memobrain/services/cloud/internal/db"
	"memobrain/services/cloud/internal/httpproblem"
	"memobrain/services/cloud/internal/quota"
	"memobrain/services/cloud/internal/settings"
	"memobrain/services/cloud/internal/storage"
	"memobrain/services/cloud/internal/vaults"
	"memobrain/shared/syncproto"
)

// MaxSingleUpload is the largest body accepted by PUT /blobs/{sha256} (§3.4.4).
const MaxSingleUpload = 32 << 20

// DefaultUploadExpiry is used when the uploads.expiry_hours setting is missing.
const DefaultUploadExpiry = 24 * time.Hour

// QuotaSource resolves the effective quota of a vault owner (quota module).
type QuotaSource interface {
	QuotaOf(ctx context.Context, userID uuid.UUID) (int64, error)
}

// Service implements the blobs module.
type Service struct {
	db    *db.DB
	store storage.BlobStore
	authz access.Authorizer
	quota QuotaSource
}

// NewService wires the module.
func NewService(d *db.DB, store storage.BlobStore, a access.Authorizer) *Service {
	return &Service{db: d, store: store, authz: a}
}

// WithQuota enables the upload quota check (see the package documentation).
func (s *Service) WithQuota(q QuotaSource) *Service {
	s.quota = q
	return s
}

// UploadExpiry is how long a resumable upload lives and how long an uploaded
// but uncommitted blob counts against the owner's quota (uploads.expiry_hours).
func (s *Service) UploadExpiry(ctx context.Context) time.Duration {
	h := settings.Int(ctx, s.db.Pool, "uploads.expiry_hours", int64(DefaultUploadExpiry/time.Hour))
	if h <= 0 {
		return DefaultUploadExpiry
	}
	return time.Duration(h) * time.Hour
}

// noUpload is the except_upload of a check that is not the finalization of a
// resumable upload.
var noUpload = uuid.Nil

// checkQuota refuses an upload of size bytes into v when the owner's used plus
// pending bytes would exceed the quota. A blob the vault holds already adds
// nothing. Inside a transaction that took lockOwner the answer stays true
// until it ends.
func (s *Service) checkQuota(ctx context.Context, tx db.DBTX, v access.Vault, hash string, size int64, exceptUpload uuid.UUID) error {
	if s.quota == nil || size <= 0 {
		return nil
	}
	limit, err := s.quota.QuotaOf(ctx, v.OwnerID)
	if err != nil || limit < 0 {
		return err
	}
	q := blobsdb.New(tx)
	if hash != "" {
		if has, err := q.VaultHasBlob(ctx, blobsdb.VaultHasBlobParams{VaultID: v.ID, Hash: hash}); err != nil || has {
			return err
		}
	}
	used, err := quota.UsedBytes(ctx, tx, v.OwnerID)
	if err != nil {
		return err
	}
	ids, err := vaults.ListVaultIDsOfOwner(ctx, tx, v.OwnerID)
	if err != nil {
		return err
	}
	pending, err := q.PendingUploadBytes(ctx, blobsdb.PendingUploadBytesParams{
		VaultIds: ids, Since: time.Now().Add(-s.UploadExpiry(ctx)), ExceptUpload: exceptUpload,
	})
	if err != nil {
		return err
	}
	if used+pending+size > limit {
		return &httpproblem.Error{
			Code:   syncproto.CodeQuotaExceeded,
			Detail: fmt.Sprintf("storage quota exceeded: %d bytes do not fit (used %d, uploaded but not committed %d, quota %d)", size, used, pending, limit),
			Extra:  map[string]any{"used_bytes": used, "pending_bytes": pending, "quota_bytes": limit},
		}
	}
	return nil
}

// lockOwner serializes the quota checks of one owner until tx ends.
func lockOwner(ctx context.Context, tx db.DBTX, ownerID uuid.UUID) error {
	return blobsdb.New(tx).LockOwnerUploads(ctx, "memobrain.uploads:"+ownerID.String())
}

// Store exposes the object store to modules that stream blobs (revisions).
func (s *Service) Store() storage.BlobStore { return s.store }

// IsHash reports whether s is a lowercase SHA-256 hex digest.
func IsHash(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// Check returns the hashes the vault does not have yet.
func (s *Service) Check(ctx context.Context, userID, vaultID uuid.UUID, scope string, hashes []string) ([]string, error) {
	if _, err := s.authz.Authorize(ctx, userID, vaultID, scope, access.Editor); err != nil {
		return nil, err
	}
	for _, h := range hashes {
		if !IsHash(h) {
			return nil, httpproblem.Errorf(syncproto.CodeValidationFailed, "invalid hash %q", h)
		}
	}
	have, err := blobsdb.New(s.db.Pool).ListVaultBlobsAmong(ctx, blobsdb.ListVaultBlobsAmongParams{VaultID: vaultID, Hashes: hashes})
	if err != nil {
		return nil, err
	}
	set := make(map[string]bool, len(have))
	for _, h := range have {
		set[h] = true
	}
	missing := []string{}
	seen := map[string]bool{}
	for _, h := range hashes {
		if !set[h] && !seen[h] {
			missing = append(missing, h)
			seen[h] = true
		}
	}
	return missing, nil
}

// spool copies r to a temporary file while hashing it and enforcing max.
func spool(r io.Reader, max int64) (path string, size int64, hash string, err error) {
	f, err := os.CreateTemp("", "memobrain-blob-*")
	if err != nil {
		return "", 0, "", err
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(r, max+1))
	cerr := f.Close()
	if err == nil {
		err = cerr
	}
	if err != nil {
		_ = os.Remove(f.Name())
		return "", 0, "", err
	}
	if n > max {
		_ = os.Remove(f.Name())
		return "", 0, "", httpproblem.Errorf(syncproto.CodeFileTooLarge, "blob larger than %d bytes", max)
	}
	return f.Name(), n, hex.EncodeToString(h.Sum(nil)), nil
}

// Put stores a blob uploaded in a single request: the body is hashed while it
// is read and the upload is rejected when the digest differs from the URL.
func (s *Service) Put(ctx context.Context, userID, vaultID uuid.UUID, scope, hash string, body io.Reader) error {
	acc, err := s.authz.Authorize(ctx, userID, vaultID, scope, access.Editor)
	if err != nil {
		return err
	}
	path, size, got, err := spool(body, MaxSingleUpload)
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(path) }()
	if got != hash {
		return httpproblem.Errorf(syncproto.CodeValidationFailed, "content hash %s does not match %s", got, hash)
	}
	// Refuse before writing to the object store; ingestFile checks again when linking.
	if err := s.checkQuota(ctx, s.db.Pool, acc.Vault, hash, size, noUpload); err != nil {
		return err
	}
	return s.ingestFile(ctx, acc.Vault, hash, path, size, noUpload)
}

// errBlobCollected means the garbage collector removed the blob (its row or
// its object) while it was being ingested: ingestFile starts over.
var errBlobCollected = errors.New("blobs: blob collected during the upload")

// ingestAttempts bounds the restarts of ingestFile after losing a race with
// the garbage collector (each collection of a hash can cost two).
const ingestAttempts = 3

// ingestFile publishes an already hashed file and links it to the vault. The
// link is the quota check that counts (atomic per owner): a blob refused there
// stays unlinked and the garbage collector removes it.
func (s *Service) ingestFile(ctx context.Context, v access.Vault, hash, path string, size int64, upload uuid.UUID) error {
	var err error
	for range ingestAttempts {
		if err = s.ingestOnce(ctx, v, hash, path, size, upload); !errors.Is(err, errBlobCollected) {
			return err
		}
	}
	return err
}

// ingestOnce is one attempt of ingestFile. The object is written (when the
// store lacks it) before any transaction; the row is published and linked
// under the per-hash lock that the garbage collector takes before deleting
// an object (LockObject), after checking again that the object is there: a
// row therefore never points to an object the collector deleted. Linking a
// blob nobody references restarts its grace period in the same transaction,
// so a deduplicated upload is not collected right after it.
func (s *Service) ingestOnce(ctx context.Context, v access.Vault, hash, path string, size int64, upload uuid.UUID) error {
	key := storage.BlobKey(hash)
	existing, err := blobsdb.New(s.db.Pool).GetBlob(ctx, hash)
	stored := false
	switch {
	case err == nil && existing.Size == size:
		// Deduplicated: the bytes were verified above. Trust the row only if the
		// object is really there (a lost object must heal on the next upload).
		got, serr := s.store.Size(ctx, existing.StorageKey)
		stored = serr == nil && got == size
	case err != nil && !errors.Is(err, pgx.ErrNoRows):
		return err
	}
	if !stored {
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		perr := s.store.Put(ctx, key, f, size)
		_ = f.Close()
		if perr != nil {
			return fmt.Errorf("store blob: %w", perr)
		}
	}
	return s.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		q := blobsdb.New(tx)
		if err := q.LockBlobHash(ctx, hash); err != nil {
			return err
		}
		if !stored {
			// Written before the lock: the collector may have deleted it since,
			// as the object of a blob it had just collected.
			got, err := s.store.Size(ctx, key)
			if errors.Is(err, storage.ErrNotFound) || (err == nil && got != size) {
				return errBlobCollected
			}
			if err != nil {
				return err
			}
			if _, err := q.InsertBlob(ctx, blobsdb.InsertBlobParams{Hash: hash, Size: size, StorageKey: key}); err != nil {
				return err
			}
		}
		// Locks the row until the commit: the collector may have deleted it
		// since GetBlob, and must not delete it now.
		if _, err := q.GetBlobKeyShare(ctx, hash); errors.Is(err, pgx.ErrNoRows) {
			return errBlobCollected
		} else if err != nil {
			return err
		}
		if err := q.RenewUnreferencedBlob(ctx, hash); err != nil {
			return err
		}
		if s.quota != nil && size > 0 {
			if err := lockOwner(ctx, tx, v.OwnerID); err != nil {
				return err
			}
			if err := s.checkQuota(ctx, tx, v, hash, size, upload); err != nil {
				return err
			}
		}
		err := q.LinkVaultBlob(ctx, blobsdb.LinkVaultBlobParams{VaultID: v.ID, Hash: hash})
		if isForeignKeyViolation(err) {
			return errBlobCollected // cannot happen under the row lock; retrying is still right
		}
		return err
	})
}

func isForeignKeyViolation(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "23503"
}

// LockObject takes, inside tx, the per-hash lock that orders the deletion of
// a blob's object against its publication (ingestFile), and reports whether
// the blob has a row. The garbage collector deletes the object of a blob it
// collected only when no row exists, before tx ends: an upload that published
// the blob again meanwhile keeps its object. tx must be a transaction (the
// lock is released when it ends).
func LockObject(ctx context.Context, tx db.DBTX, hash string) (rowExists bool, err error) {
	q := blobsdb.New(tx)
	if err := q.LockBlobHash(ctx, hash); err != nil {
		return false, err
	}
	if _, err := q.GetBlob(ctx, hash); errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	} else if err != nil {
		return false, err
	}
	return true, nil
}

// Range is a resolved byte range.
type Range struct{ Start, End int64 } // inclusive

// ErrRange means the Range header cannot be satisfied.
var ErrRange = errors.New("blobs: range not satisfiable")

// ParseRange resolves a single "bytes=" range against size. ok is false for
// no header or a form we ignore (multiple ranges): serve the whole blob.
func ParseRange(header string, size int64) (r Range, ok bool, err error) {
	spec, found := strings.CutPrefix(header, "bytes=")
	if !found || strings.Contains(spec, ",") {
		return Range{}, false, nil
	}
	a, b, found := strings.Cut(spec, "-")
	if !found {
		return Range{}, false, nil
	}
	switch a {
	case "":
		n, e := strconv.ParseInt(b, 10, 64)
		if e != nil || n <= 0 {
			return Range{}, false, ErrRange
		}
		if n > size {
			n = size
		}
		return Range{Start: size - n, End: size - 1}, size > 0, nil
	default:
		start, e := strconv.ParseInt(a, 10, 64)
		if e != nil || start < 0 || start >= size {
			return Range{}, false, ErrRange
		}
		end := size - 1
		if b != "" {
			e, perr := strconv.ParseInt(b, 10, 64)
			if perr != nil || e < start {
				return Range{}, false, ErrRange
			}
			end = min(e, size-1)
		}
		return Range{Start: start, End: end}, true, nil
	}
}

// Open returns a reader for the blob (optionally a range of it) after
// verifying the vault owns it and, through a share, that the blob belongs to
// a file the share covers.
func (s *Service) Open(ctx context.Context, userID, vaultID uuid.UUID, scope, hash string, rng *Range) (io.ReadCloser, int64, error) {
	if err := s.authorizeRead(ctx, userID, vaultID, scope, hash); err != nil {
		return nil, 0, err
	}
	return s.OpenForVault(ctx, vaultID, hash, rng)
}

// authorizeRead lets the owner read any blob of the vault and a share recipient only the
// blobs of files inside the share (a hash learnt elsewhere gives nothing outside it).
func (s *Service) authorizeRead(ctx context.Context, userID, vaultID uuid.UUID, scope, hash string) error {
	acc, err := s.authz.Authorize(ctx, userID, vaultID, scope, access.Viewer)
	if err != nil {
		return err
	}
	if acc.Scope == nil {
		return nil
	}
	files, err := blobsdb.New(s.db.Pool).ListBlobFiles(ctx, blobsdb.ListBlobFilesParams{VaultID: vaultID, BlobHash: &hash})
	if err != nil {
		return err
	}
	for _, f := range files {
		if acc.Scope.ContainsFile(f.ID, f.Path) {
			return nil
		}
	}
	return httpproblem.NotFound("blob")
}

// OpenForVault is Open for callers that already authorized the vault.
func (s *Service) OpenForVault(ctx context.Context, vaultID uuid.UUID, hash string, rng *Range) (io.ReadCloser, int64, error) {
	q := blobsdb.New(s.db.Pool)
	ok, err := q.VaultHasBlob(ctx, blobsdb.VaultHasBlobParams{VaultID: vaultID, Hash: hash})
	if err != nil {
		return nil, 0, err
	}
	if !ok {
		return nil, 0, httpproblem.NotFound("blob")
	}
	b, err := q.GetBlob(ctx, hash)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, 0, httpproblem.NotFound("blob")
	}
	if err != nil {
		return nil, 0, err
	}
	off, length := int64(0), int64(-1)
	if rng != nil {
		off, length = rng.Start, rng.End-rng.Start+1
	}
	rc, err := s.store.Get(ctx, b.StorageKey, off, length)
	if errors.Is(err, storage.ErrNotFound) {
		return nil, 0, httpproblem.NotFound("blob")
	}
	return rc, b.Size, err
}

// Size returns the size of a blob the vault owns.
func (s *Service) Size(ctx context.Context, userID, vaultID uuid.UUID, scope, hash string) (int64, error) {
	if err := s.authorizeRead(ctx, userID, vaultID, scope, hash); err != nil {
		return 0, err
	}
	size, ok, err := VaultBlob(ctx, s.db.Pool, vaultID, hash)
	if err != nil {
		return 0, err
	}
	if !ok {
		return 0, httpproblem.NotFound("blob")
	}
	return size, nil
}

// VaultBlob reports whether the vault owns the blob and its size. Inside a
// transaction it also locks the blob against the garbage collector until the
// transaction ends, so a commit can safely reference it; a blob the collector
// deleted meanwhile is reported as missing.
func VaultBlob(ctx context.Context, tx db.DBTX, vaultID uuid.UUID, hash string) (size int64, ok bool, err error) {
	size, err = blobsdb.New(tx).GetVaultBlobKeyShare(ctx, blobsdb.GetVaultBlobKeyShareParams{VaultID: vaultID, Hash: hash})
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	return size, true, nil
}

// AddRef adjusts the revision reference count of a blob; it must run in the
// transaction that inserts or deletes the revision.
func AddRef(ctx context.Context, tx db.DBTX, hash string, delta int32) error {
	return blobsdb.New(tx).AddBlobRef(ctx, blobsdb.AddBlobRefParams{Hash: hash, RefCount: delta})
}

// AddRefs is AddRef for many blobs at once (deltas[i] applies to hashes[i]);
// the rows are locked in hash order. It must run in the transaction that
// inserts or deletes the revisions.
func AddRefs(ctx context.Context, tx db.DBTX, hashes []string, deltas []int32) error {
	if len(hashes) == 0 {
		return nil
	}
	return blobsdb.New(tx).AddBlobRefs(ctx, blobsdb.AddBlobRefsParams{Hashes: hashes, Deltas: deltas})
}
