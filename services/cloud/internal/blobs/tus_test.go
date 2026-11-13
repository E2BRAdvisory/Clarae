package blobs

import (
	"errors"
	"fmt"
	"slices"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"clarae/services/cloud/internal/blobs/blobsdb"
)

func TestChunkKeys(t *testing.T) {
	id := uuid.MustParse("01890000-0000-7000-8000-000000000001")
	legacy := func(n int) string { return fmt.Sprintf("uploads/%s/%08d", id, n) }
	cases := []struct {
		name   string
		chunks int32
		keys   []string
		want   []string
	}{
		{"empty", 0, nil, nil},
		{"current", 2, []string{"uploads/x/a", "uploads/x/b"}, []string{"uploads/x/a", "uploads/x/b"}},
		{"legacy", 3, nil, []string{legacy(0), legacy(1), legacy(2)}},
		// Created before chunk_keys, resumed after the upgrade: the numbered
		// chunks come first, then the ones the new PATCHes recorded.
		{"mixed", 3, []string{"uploads/x/c"}, []string{legacy(0), legacy(1), "uploads/x/c"}},
	}
	for _, c := range cases {
		got := chunkKeys(blobsdb.Upload{ID: id, Chunks: c.chunks, ChunkKeys: c.keys})
		if !slices.Equal(got, c.want) {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
}

func TestItemErrors(t *testing.T) {
	var e itemErrors
	if e.err() != nil {
		t.Fatal("no failure reported as an error")
	}
	sentinel := errors.New("first")
	e.add(sentinel)
	for range 9 {
		e.add(errors.New("more"))
	}
	err := e.err()
	if err == nil || !errors.Is(err, sentinel) || len(e.first) != 5 || e.n != 10 {
		t.Fatalf("aggregate: %v (kept %d of %d)", err, len(e.first), e.n)
	}
}

func TestIsForeignKeyViolation(t *testing.T) {
	if isForeignKeyViolation(nil) || isForeignKeyViolation(errors.New("x")) || isForeignKeyViolation(&pgconn.PgError{Code: "23505"}) {
		t.Fatal("false positive")
	}
	if !isForeignKeyViolation(fmt.Errorf("link: %w", &pgconn.PgError{Code: "23503"})) {
		t.Fatal("wrapped foreign key violation not recognised")
	}
}
