// Package blobs owns the content-addressed store: the blobs and vault_blobs
// tables, upload of blobs up to 32 MB and resumable tus uploads for larger
// ones, download with Range, and reference counting (M2-WP1).
//
// A blob is stored once per hash but a vault can only read or reference blobs
// it uploaded itself (vault_blobs): that keeps "blobs:check" from revealing
// what other users store and makes knowing a hash worthless without the bytes.
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

	"memobrain/services/cloud/internal/access"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"memobrain/services/cloud/internal/blobs/blobsdb"
	"memobrain/services/cloud/internal/db"
	"memobrain/services/cloud/internal/httpproblem"
	"memobrain/services/cloud/internal/storage"
	"memobrain/shared/syncproto"
)

// MaxSingleUpload is the largest body accepted by PUT /blobs/{sha256} (§3.4.4).
const MaxSingleUpload = 32 << 20

// Service implements the blobs module.
type Service struct {
	db    *db.DB
	store storage.BlobStore
	authz access.Authorizer
}

// NewService wires the module.
func NewService(d *db.DB, store storage.BlobStore, a access.Authorizer) *Service {
	return &Service{db: d, store: store, authz: a}
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
	if _, err := s.authz.Authorize(ctx, userID, vaultID, scope, access.Editor); err != nil {
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
	return s.ingestFile(ctx, vaultID, hash, path, size)
}

// IngestFile stores an already hashed file (used by tus finalization).
func (s *Service) IngestFile(ctx context.Context, vaultID uuid.UUID, hash, path string, size int64) error {
	return s.ingestFile(ctx, vaultID, hash, path, size)
}

func (s *Service) ingestFile(ctx context.Context, vaultID uuid.UUID, hash, path string, size int64) error {
	q := blobsdb.New(s.db.Pool)
	existing, err := q.GetBlob(ctx, hash)
	if err == nil && existing.Size == size {
		// Deduplicated: the bytes were verified above. Trust the row only if the
		// object is really there (a lost object must heal on the next upload).
		if got, serr := s.store.Size(ctx, existing.StorageKey); serr != nil || got != size {
			err = pgx.ErrNoRows
		}
	}
	switch {
	case err == nil && existing.Size == size:
		// Present in the store: nothing to write.
	case err == nil || errors.Is(err, pgx.ErrNoRows):
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer func() { _ = f.Close() }()
		if err := s.store.Put(ctx, storage.BlobKey(hash), f, size); err != nil {
			return fmt.Errorf("store blob: %w", err)
		}
		if _, err := q.InsertBlob(ctx, blobsdb.InsertBlobParams{Hash: hash, Size: size, StorageKey: storage.BlobKey(hash)}); err != nil {
			return err
		}
	default:
		return err
	}
	return q.LinkVaultBlob(ctx, blobsdb.LinkVaultBlobParams{VaultID: vaultID, Hash: hash})
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
	q := blobsdb.New(tx)
	has, err := q.VaultHasBlob(ctx, blobsdb.VaultHasBlobParams{VaultID: vaultID, Hash: hash})
	if err != nil || !has {
		return 0, false, err
	}
	b, err := q.GetBlobKeyShare(ctx, hash)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	return b.Size, true, nil
}

// AddRef adjusts the revision reference count of a blob; it must run in the
// transaction that inserts or deletes the revision.
func AddRef(ctx context.Context, tx db.DBTX, hash string, delta int32) error {
	return blobsdb.New(tx).AddBlobRef(ctx, blobsdb.AddBlobRefParams{Hash: hash, RefCount: delta})
}
