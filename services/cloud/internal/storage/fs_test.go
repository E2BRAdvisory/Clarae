package storage

import (
	"bytes"
	"context"
	"errors"
	"io"
	"slices"
	"testing"
)

// listKeys lists the keys below prefix, sorted.
func listKeys(t *testing.T, s BlobStore, prefix string) []string {
	t.Helper()
	var keys []string
	err := s.List(context.Background(), prefix, func(o ObjectInfo) error {
		if o.Modified.IsZero() || o.Size != 1 {
			t.Errorf("%s: size %d, modified %v", o.Key, o.Size, o.Modified)
		}
		keys = append(keys, o.Key)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	slices.Sort(keys)
	return keys
}

func TestFSList(t *testing.T) {
	ctx := context.Background()
	s, err := NewFS(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"uploads/a/1", "uploads/a/2", "uploads/b/1", "uploadsx/1", "blobs/ab/x"} {
		if err := s.Put(ctx, k, bytes.NewReader([]byte{1}), 1); err != nil {
			t.Fatal(err)
		}
	}
	if got := listKeys(t, s, "uploads/"); !slices.Equal(got, []string{"uploads/a/1", "uploads/a/2", "uploads/b/1"}) {
		t.Errorf("uploads/: %v", got)
	}
	// A prefix need not be a directory.
	if got := listKeys(t, s, "uploads"); len(got) != 4 {
		t.Errorf("uploads: %v", got)
	}
	if got := listKeys(t, s, ""); len(got) != 5 {
		t.Errorf("everything: %v", got)
	}
	if got := listKeys(t, s, "missing/"); len(got) != 0 {
		t.Errorf("missing prefix: %v", got)
	}
	// An error from the callback stops the listing.
	stop := errors.New("stop")
	calls := 0
	err = s.List(ctx, "uploads/", func(ObjectInfo) error { calls++; return stop })
	if !errors.Is(err, stop) || calls != 1 {
		t.Errorf("stop: %v after %d calls", err, calls)
	}
}

func TestFSStore(t *testing.T) {
	ctx := context.Background()
	s, err := NewFS(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	key := BlobKey("ab" + string(bytes.Repeat([]byte{'0'}, 62)))
	data := []byte("0123456789")
	if err := s.Put(ctx, key, bytes.NewReader(data), int64(len(data))); err != nil {
		t.Fatal(err)
	}
	if n, err := s.Size(ctx, key); err != nil || n != 10 {
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
	if read(0, -1) != "0123456789" || read(3, 4) != "3456" || read(8, -1) != "89" {
		t.Error("ranges wrong")
	}
	// A short write is an error and leaves nothing behind.
	if err := s.Put(ctx, "x/y", bytes.NewReader([]byte("abc")), 10); err == nil {
		t.Error("size mismatch accepted")
	}
	if _, err := s.Size(ctx, "x/y"); !errors.Is(err, ErrNotFound) {
		t.Errorf("partial object visible: %v", err)
	}
	if err := s.Delete(ctx, key); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(ctx, key); err != nil {
		t.Errorf("deleting twice: %v", err)
	}
	if _, err := s.Get(ctx, key, 0, -1); !errors.Is(err, ErrNotFound) {
		t.Errorf("get after delete: %v", err)
	}
	for _, bad := range []string{"", "../escape", "/abs", "a/../../b"} {
		if err := s.Put(ctx, bad, bytes.NewReader(nil), 0); err == nil {
			t.Errorf("key %q accepted", bad)
		}
	}
}
