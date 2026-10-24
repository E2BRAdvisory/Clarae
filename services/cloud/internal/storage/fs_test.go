package storage

import (
	"bytes"
	"context"
	"errors"
	"io"
	"testing"
)

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
