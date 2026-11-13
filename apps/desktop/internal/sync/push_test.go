package sync

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	stdsync "sync"
	"testing"

	"github.com/rs/zerolog"

	"clarae/apps/desktop/internal/store"
	"clarae/apps/desktop/internal/sync/transport"
	"clarae/apps/desktop/internal/vault"
	"clarae/shared/syncproto"
)

// memRemote is an empty vault on a server that accepts every commit. Blobs
// listed in refuse are rejected as too large, as a server with a lower limit
// than the device's would do.
type memRemote struct {
	mu        stdsync.Mutex // uploads run at once
	refuse    map[string]bool
	uploaded  []string
	committed []string // paths
}

func (r *memRemote) Tree(context.Context) (transport.Tree, error) { return transport.Tree{}, nil }

func (r *memRemote) Changes(context.Context, int64, string, int) (transport.Changes, error) {
	return transport.Changes{}, nil
}

func (r *memRemote) CheckBlobs(_ context.Context, hashes []string) ([]string, error) {
	return hashes, nil
}

func (r *memRemote) Upload(_ context.Context, hash string, _ []byte, _ string) (string, error) {
	if r.refuse[hash] {
		return "", &transport.ProblemError{StatusCode: http.StatusRequestEntityTooLarge, Problem: syncproto.Problem{Code: syncproto.CodeFileTooLarge, Detail: "blob larger than the limit"}}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
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

func newTestEngine(t testing.TB, remote Remote, maxFile int64) (*Engine, string) {
	t.Helper()
	dir := t.TempDir()
	fs, err := vault.NewFS(dir)
	if err != nil {
		t.Fatal(err)
	}
	sdb, err := store.Open(context.Background(), filepath.Join(dir, ".clarae", "sync.db"), store.KindSync)
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

// heldRemote reports the content uploaded and can fail one commit, as a
// connection lost after the blobs went up would.
type heldRemote struct {
	memRemote
	onUpload   func(n int)
	onCommit   func() // after each commit (successful or not)
	commits    int
	failCommit int                 // 1-based commit that fails (0: none)
	opIDs      map[string][]string // file id → op ids, in the order sent
}

func (r *heldRemote) Upload(ctx context.Context, hash string, data []byte, url string) (string, error) {
	if r.onUpload != nil {
		r.mu.Lock()
		r.onUpload(len(data))
		r.mu.Unlock()
	}
	return r.memRemote.Upload(ctx, hash, data, url)
}

func (r *heldRemote) Commit(ctx context.Context, req syncproto.CommitRequest) (syncproto.CommitResponse, error) {
	r.commits++
	for _, op := range req.Ops {
		r.opIDs[op.FileID] = append(r.opIDs[op.FileID], op.OpID)
	}
	if r.onCommit != nil {
		defer r.onCommit()
	}
	if r.commits == r.failCommit {
		return syncproto.CommitResponse{}, errors.New("connection reset")
	}
	return r.memRemote.Commit(ctx, req)
}

// A push of several times the batch limit reads the files of a batch only
// when that batch is sent: at no point is more than one batch plus one file
// of content held (the first sync of a large vault does not load it whole).
func TestPushHoldsAtMostOneBatchOfContent(t *testing.T) {
	const limit, files = 4000, 40
	held, peak, largest, total := 0, 0, 0, 0
	remote := &heldRemote{opIDs: map[string][]string{}, onUpload: func(n int) { held -= n }}
	e, dir := newTestEngine(t, remote, 0)
	e.batchBytes = limit
	const grown = 900 // appended between the scan and the read to every fifth file, once
	grew := map[string]bool{}
	read := e.readFile
	e.readFile = func(rel string) (vault.Content, error) {
		var i int
		if _, err := fmt.Sscanf(rel, "f%02d.bin", &i); err == nil && i%5 == 0 && !grew[rel] {
			grew[rel] = true
			f, err := os.OpenFile(filepath.Join(dir, rel), os.O_APPEND|os.O_WRONLY, 0)
			if err != nil {
				t.Error(err)
			} else {
				_, _ = f.Write(bytes.Repeat([]byte{'+'}, grown))
				_ = f.Close()
			}
		}
		c, err := read(rel)
		if err == nil {
			if held += len(c.Data); held > peak {
				peak = held
			}
		}
		return c, err
	}
	for i := range files {
		// 600-1500 bytes, some larger when read than when scanned: batches
		// end both on the scanned size and on a file carried to the next one.
		data := bytes.Repeat([]byte{byte('a' + i%26)}, 600+(i%7)*150)
		data = append(data, fmt.Sprintf("\nfile %d\n", i)...)
		n := len(data)
		if i%5 == 0 {
			n += grown
		}
		largest, total = max(largest, n), total+n
		writeFile(t, dir, fmt.Sprintf("f%02d.bin", i), data)
	}
	if total < 5*limit {
		t.Fatalf("test vault of %d bytes is not several times the limit", total)
	}
	if err := e.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}
	// The grown files went with the content read (recorded as synced), so
	// no round sends them again.
	if len(remote.committed) != files || len(remote.uploaded) != files {
		t.Fatalf("committed %d, uploaded %d, want %d each", len(remote.committed), len(remote.uploaded), files)
	}
	if remote.commits < total/limit {
		t.Fatalf("%d commits for %d bytes: batches exceed the limit of %d", remote.commits, total, limit)
	}
	if peak > limit+largest {
		t.Fatalf("held up to %d bytes of content, want at most %d (one batch and one file)", peak, limit+largest)
	}
	if held != 0 {
		t.Fatalf("%d bytes read but never uploaded", held)
	}
}

// A commit lost after its blobs were uploaded is sent again with the same
// operation ids (the server's idempotency), in a shared vault and in a
// private one (where the ciphertext comes back from the outbox cache).
func TestPushRetryAfterFailedCommitKeepsOpIDs(t *testing.T) {
	for _, private := range []bool{false, true} {
		t.Run(fmt.Sprintf("private=%v", private), func(t *testing.T) {
			remote := &heldRemote{opIDs: map[string][]string{}, failCommit: 2}
			var e *Engine
			var dir string
			if private {
				e, _, _, dir = newCryptoEngine(t, remote)
			} else {
				e, dir = newTestEngine(t, remote, 0)
			}
			e.batchBytes = 2500 // two files per batch: the second batch fails
			for i := range 6 {
				writeFile(t, dir, fmt.Sprintf("n%d.md", i), bytes.Repeat([]byte{byte('a' + i)}, 1000))
			}
			if err := e.Sync(context.Background()); err == nil {
				t.Fatal("the failed commit did not fail the sync")
			}
			if err := e.Sync(context.Background()); err != nil {
				t.Fatal(err)
			}
			if len(remote.opIDs) != 6 {
				t.Fatalf("%d files committed, want 6", len(remote.opIDs))
			}
			retried := 0
			for id, ops := range remote.opIDs {
				if len(ops) > 1 {
					retried++
				}
				for _, op := range ops[1:] {
					if op != ops[0] {
						t.Fatalf("file %s sent with op ids %v: the retry is not idempotent", id, ops)
					}
				}
			}
			if retried != 2 {
				t.Fatalf("%d operations sent twice, want the 2 of the failed commit", retried)
			}
		})
	}
}

// The vault is locked after the first batch went through: the next batch
// cannot be encrypted, the cycle ends as locked with the first batch recorded
// as synced and the other files still pending (never parked: the lock is not
// their fault), and after the unlock each of them is sent exactly once.
func TestPushLockedBetweenBatchesKeepsTheRest(t *testing.T) {
	ctx := context.Background()
	remote := &heldRemote{opIDs: map[string][]string{}}
	e, c, dir := newPrivateEngine(t, remote)
	if err := e.cfg.DB.SetMeta(ctx, MetaBootstrapped, "1"); err != nil {
		t.Fatal(err)
	}
	e.batchBytes = 2500 // two files per batch
	remote.onCommit = func() {
		if remote.commits == 1 {
			c.locked.Store(true)
		}
	}
	for i := range 6 {
		writeFile(t, dir, fmt.Sprintf("n%d.md", i), bytes.Repeat([]byte{byte('a' + i)}, 1000))
	}
	if err := e.Sync(ctx); !errors.Is(err, ErrLocked) {
		t.Fatalf("sync error = %v, want ErrLocked", err)
	}
	if st := e.Status(); st.Phase != PhaseLocked {
		t.Fatalf("phase = %s, want locked", st.Phase)
	}
	if len(remote.opIDs) != 2 {
		t.Fatalf("%d files committed before the lock, want the 2 of the first batch", len(remote.opIDs))
	}
	synced := 0
	for i := range 6 {
		row := parked(t, e, fmt.Sprintf("n%d.md", i))
		if row.Attempts != 0 || row.LastError != "" {
			t.Fatalf("%s parked by the lock: %+v", row.Path, row)
		}
		if row.State == StateSynced {
			synced++
		}
	}
	if synced != 2 {
		t.Fatalf("%d files recorded as synced, want the 2 committed", synced)
	}

	c.locked.Store(false)
	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if len(remote.opIDs) != 6 {
		t.Fatalf("%d files committed after the unlock, want 6", len(remote.opIDs))
	}
	for id, ops := range remote.opIDs {
		if len(ops) != 1 {
			t.Fatalf("file %s sent %d times", id, len(ops))
		}
	}
}

// A push cancelled after its first batch reads no further file (nor, in a
// private vault, encrypts one): the files of the next batches stay pending,
// never parked, and the next cycle sends each of them once.
func TestPushCancelledBetweenBatchesReadsNoMore(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	remote := &heldRemote{opIDs: map[string][]string{}}
	e, dir := newTestEngine(t, remote, 0)
	e.batchBytes = 2500 // two files per batch
	reads, cancelled := 0, false
	read := e.readFile
	e.readFile = func(rel string) (vault.Content, error) {
		if cancelled {
			reads++
		}
		return read(rel)
	}
	e.cfg.OnStatus = func(s Status) {
		if s.Total == 6 && s.Done == 2 && !cancelled { // the first batch is recorded
			cancel()
			cancelled = true
		}
	}
	for i := range 6 {
		writeFile(t, dir, fmt.Sprintf("n%d.md", i), bytes.Repeat([]byte{byte('a' + i)}, 1000))
	}
	if err := e.Sync(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("sync error = %v, want context.Canceled", err)
	}
	if reads != 0 {
		t.Fatalf("%d files read after the cancellation", reads)
	}
	if len(remote.opIDs) != 2 {
		t.Fatalf("%d files committed before the cancellation, want the 2 of the first batch", len(remote.opIDs))
	}
	for i := range 6 {
		if row := parked(t, e, fmt.Sprintf("n%d.md", i)); row.Attempts != 0 || row.LastError != "" {
			t.Fatalf("%s parked by the cancellation: %+v", row.Path, row)
		}
	}

	if err := e.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(remote.opIDs) != 6 {
		t.Fatalf("%d files committed after the cancellation, want 6", len(remote.opIDs))
	}
	for id, ops := range remote.opIDs {
		if len(ops) != 1 {
			t.Fatalf("file %s sent %d times", id, len(ops))
		}
	}
}
