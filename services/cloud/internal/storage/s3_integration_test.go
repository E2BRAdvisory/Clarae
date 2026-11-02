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

	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"

	"memobrain/services/cloud/internal/storage"
)

// rustfsImage is the S3 server of the deployment (deploy/PINS.md), pinned by
// version and digest like there. MinIO no longer publishes images on Docker Hub.
const rustfsImage = "rustfs/rustfs:1.0.4@sha256:ed9210d6411d77ffceb70d94b964a3cb7d225983368bc25bebe01e995293dcc2"

// TestS3Store runs the BlobStore contract against a real S3 server: the one in
// MEMOBRAIN_TEST_S3_ENDPOINT (credentials in MEMOBRAIN_TEST_S3_KEY/SECRET) or a RustFS container.
func TestS3Store(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	opts := storage.S3Options{Endpoint: os.Getenv("MEMOBRAIN_TEST_S3_ENDPOINT"), AccessKey: os.Getenv("MEMOBRAIN_TEST_S3_KEY"), SecretKey: os.Getenv("MEMOBRAIN_TEST_S3_SECRET"), Region: "us-east-1", Bucket: "memobrain-test-blobs", UsePathStyle: true}
	if opts.Endpoint == "" {
		c, err := testcontainers.Run(ctx, rustfsImage,
			testcontainers.WithEnv(map[string]string{
				"RUSTFS_ACCESS_KEY": "memobrain", "RUSTFS_SECRET_KEY": "memobrain-secret",
				"RUSTFS_VOLUMES": "/data", "RUSTFS_ADDRESS": ":9000",
			}),
			testcontainers.WithExposedPorts("9000/tcp"),
			testcontainers.WithWaitStrategy(wait.ForListeningPort("9000/tcp").WithStartupTimeout(60*time.Second)),
		)
		if err != nil {
			t.Skipf("no S3 server available: %v", err)
		}
		t.Cleanup(func() { _ = c.Terminate(context.Background()) })
		addr, err := c.PortEndpoint(ctx, "9000/tcp", "http")
		if err != nil {
			t.Fatal(err)
		}
		opts.Endpoint, opts.AccessKey, opts.SecretKey = addr, "memobrain", "memobrain-secret"
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
	chunk := "uploads/" + time.Now().Format("150405.000000") + "/1"
	if err := s.Put(ctx, chunk, bytes.NewReader([]byte{1}), 1); err != nil {
		t.Fatal(err)
	}
	var listed []storage.ObjectInfo
	if err := s.List(ctx, "uploads/", func(o storage.ObjectInfo) error { listed = append(listed, o); return nil }); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, o := range listed {
		if o.Key == key {
			t.Errorf("listed %s outside the prefix", o.Key)
		}
		found = found || (o.Key == chunk && o.Size == 1 && !o.Modified.IsZero())
	}
	if !found {
		t.Errorf("chunk not listed: %v", listed)
	}
	_ = s.Delete(ctx, chunk)
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
