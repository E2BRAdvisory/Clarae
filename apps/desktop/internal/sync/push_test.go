package sync

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rs/zerolog"

	"memobrain/apps/desktop/internal/store"
	"memobrain/apps/desktop/internal/sync/transport"
	"memobrain/apps/desktop/internal/vault"
	"memobrain/shared/syncproto"
)

// memRemote is an empty vault on a server that accepts every commit. Blobs
// listed in refuse are rejected as too large, as a server with a lower limit
// than the device's would do.
type memRemote struct {
	refuse    map[string]bool
	uploaded  []string
	committed []string // paths
}

func (r *memRemote) Tree(context.Context) (transport.Tree, error) { return transport.Tree{}, nil }

func (r *memRemote) Changes(context.Context, int64, int) (transport.Changes, error) {
	return transport.Changes{}, nil
}

func (r *memRemote) CheckBlobs(_ context.Context, hashes []string) ([]string, error) {
	return hashes, nil
}

func (r *memRemote) Upload(_ context.Context, hash string, _ []byte, _ string) (string, error) {
	if r.refuse[hash] {
		return "", &transport.ProblemError{StatusCode: http.StatusRequestEntityTooLarge, Problem: syncproto.Problem{Code: syncproto.CodeFileTooLarge, Detail: "blob larger than the limit"}}
	}
	r.uploaded = append(r.uploaded, hash)
	return "", nil
}

func (r *memRemote) Download(context.Context, string, io.Writer) error { return os.ErrNotExist }

func (r *memRemote) RevisionContent(context.Context, string, int, io.Writer) error {
	return os.ErrNotExist
}

func (r *memRemote) Commit(_ context.Context, req syncproto.CommitRequest) (syncproto.CommitResponse, error) {
	resp := syncproto.CommitResponse{}
	for i, op := range req.Ops {
		r.committed = append(r.committed, op.Path)
		resp.Results = append(resp.Results, syncproto.OpResult{OpID: op.OpID, Status: syncproto.StatusAccepted, FileID: op.FileID, Rev: 1, Seq: int64(i + 1)})
	}
	return resp, nil
}

func newTestEngine(t *testing.T, remote Remote, maxFile int64) (*Engine, string) {
	t.Helper()
	dir := t.TempDir()
	fs, err := vault.NewFS(dir)
	if err != nil {
		t.Fatal(err)
	}
	sdb, err := store.Open(context.Background(), filepath.Join(dir, ".memobrain", "sync.db"), store.KindSync)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sdb.Close() })
	return New(Config{
		LocalID: "v", FS: fs, DB: NewDB(sdb), Remote: remote, DeviceID: "d", DeviceName: "test", UserID: "u",
		Logger: zerolog.Nop(), MaxFileBytes: func() int64 { return maxFile },
	}), dir
}

func writeFile(t *testing.T, dir, name string, data []byte) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func parked(t *testing.T, e *Engine, path string) File {
	t.Helper()
	rows, err := e.cfg.DB.Files(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range rows {
		if r.Path == path {
			return r
		}
	}
	t.Fatalf("no sync row for %s", path)
	return File{}
}

func hashOf(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// §3.4.2: a file over the limit is refused by the client before it is read
// or encrypted, and does not hold back the others.
func TestOversizedFileIsParkedBeforeUpload(t *testing.T) {
	remote := &memRemote{}
	e, dir := newTestEngine(t, remote, 1024)
	writeFile(t, dir, "big.bin", bytes.Repeat([]byte{1}, 2048))
	writeFile(t, dir, "note.md", []byte("# small"))

	if err := e.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(remote.committed) != 1 || remote.committed[0] != "note.md" {
		t.Fatalf("committed %v, want only note.md", remote.committed)
	}
	if len(remote.uploaded) != 1 || remote.uploaded[0] != hashOf([]byte("# small")) {
		t.Fatalf("uploaded %v: the large file was sent", remote.uploaded)
	}
	row := parked(t, e, "big.bin")
	if row.Attempts < MaxAttempts || !strings.HasPrefix(row.LastError, string(syncproto.CodeFileTooLarge)) {
		t.Fatalf("big.bin not parked as too large: %+v", row)
	}
}

// A server limit lower than the device's: the refused blob parks its file and
// the rest of the batch is committed instead of the whole push failing.
func TestServerRefusalParksOnlyThatFile(t *testing.T) {
	big := bytes.Repeat([]byte{2}, 4096)
	remote := &memRemote{refuse: map[string]bool{hashOf(big): true}}
	e, dir := newTestEngine(t, remote, 0) // 0: the protocol default, far above 4 KB
	writeFile(t, dir, "big.bin", big)
	writeFile(t, dir, "note.md", []byte("# small"))

	if err := e.Sync(context.Background()); err != nil {
		t.Fatalf("one refused blob failed the whole sync: %v", err)
	}
	if len(remote.committed) != 1 || remote.committed[0] != "note.md" {
		t.Fatalf("committed %v, want only note.md", remote.committed)
	}
	if row := parked(t, e, "big.bin"); row.Attempts < MaxAttempts || !strings.Contains(row.LastError, string(syncproto.CodeFileTooLarge)) {
		t.Fatalf("big.bin not parked: %+v", row)
	}
	// Parked: the next cycle does not try again.
	remote.committed = nil
	if err := e.Sync(context.Background()); err != nil || len(remote.committed) != 0 {
		t.Fatalf("second sync: %v, committed %v", err, remote.committed)
	}
}
