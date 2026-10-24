// Package storage abstracts the object store that holds blob content (§4.3):
// S3-compatible in production, a directory for tests and single-node dev.
package storage

import (
	"context"
	"errors"
	"io"
	"time"
)

// ErrNotFound is returned when an object does not exist.
var ErrNotFound = errors.New("storage: object not found")

// BlobStore stores immutable objects addressed by key.
type BlobStore interface {
	// Put stores size bytes from r under key (replacing any existing object).
	Put(ctx context.Context, key string, r io.Reader, size int64) error
	// Get opens the object; length < 0 reads to the end. The caller closes it.
	Get(ctx context.Context, key string, offset, length int64) (io.ReadCloser, error)
	// Size returns the object size, or ErrNotFound.
	Size(ctx context.Context, key string) (int64, error)
	// Delete removes the object; deleting a missing object is not an error.
	Delete(ctx context.Context, key string) error
	// Ping checks reachability (readiness probe).
	Ping(ctx context.Context) error
}

// BlobKey is the object key of a content-addressed blob; the two-level
// prefix keeps directory listings small on the filesystem implementation.
func BlobKey(hash string) string {
	return "blobs/" + hash[:2] + "/" + hash
}

// Presigner is implemented by stores that can hand out direct, time-limited download URLs.
type Presigner interface {
	// PresignGet returns the URL, or "" when the store cannot (not configured).
	PresignGet(ctx context.Context, key, filename string, ttl time.Duration) (string, error)
}
