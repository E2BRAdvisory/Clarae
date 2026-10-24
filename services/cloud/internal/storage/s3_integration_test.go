//go:build integration

package storage_test

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"testing"
	"time"

	tcminio "github.com/testcontainers/testcontainers-go/modules/minio"

	"nodus/services/cloud/internal/storage"
)

// TestS3Store runs the BlobStore contract against a real S3 server: the one in
// NODUS_TEST_S3_ENDPOINT (credentials in NODUS_TEST_S3_KEY/SECRET) or a MinIO container.
func TestS3Store(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	opts := storage.S3Options{Endpoint: os.Getenv("NODUS_TEST_S3_ENDPOINT"), AccessKey: os.Getenv("NODUS_TEST_S3_KEY"), SecretKey: os.Getenv("NODUS_TEST_S3_SECRET"), Region: "us-east-1", Bucket: "nodus-test-blobs", UsePathStyle: true}
	if opts.Endpoint == "" {
		c, err := tcminio.Run(ctx, "minio/minio:latest")
		if err != nil {
			t.Skipf("no S3 server available: %v", err)
		}
		t.Cleanup(func() { _ = c.Terminate(context.Background()) })
		addr, err := c.ConnectionString(ctx)
		if err != nil {
			t.Fatal(err)
		}
		opts.Endpoint, opts.AccessKey, opts.SecretKey = "http://"+addr, c.Username, c.Password
	}
	s, err := storage.NewS3(ctx, opts)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	key := storage.BlobKey("cd" + string(bytes.Repeat([]byte{'1'}, 62)))
	data := []byte("0123456789abcdef")
	if err := s.Put(ctx, key, bytes.NewReader(data), int64(len(data))); err != nil {
		t.Fatal(err)
	}
	if n, err := s.Size(ctx, key); err != nil || n != int64(len(data)) {
		t.Fatalf("size %d %v", n, err)
	}
	read := func(off, length int64) string {
		rc, err := s.Get(ctx, key, off, length)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = rc.Close() }()
		b, _ := io.ReadAll(rc)
		return string(b)
	}
	if read(0, -1) != string(data) || read(4, 6) != "456789" || read(10, -1) != "abcdef" {
		t.Error("range reads wrong")
	}
	if err := s.Delete(ctx, key); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(ctx, key); err != nil {
		t.Errorf("deleting a missing object: %v", err)
	}
	if _, err := s.Get(ctx, key, 0, -1); !errors.Is(err, storage.ErrNotFound) {
		t.Errorf("get after delete: %v", err)
	}
	if _, err := s.Size(ctx, key); !errors.Is(err, storage.ErrNotFound) {
		t.Errorf("size after delete: %v", err)
	}
}
