package sync

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	stdsync "sync"
	"testing"
	"time"

	"clarae/apps/desktop/internal/sync/transport"
	"clarae/shared/syncproto"
)

// slowRemote is a scriptRemote whose transfers take time, as on a distant
// server: it records how many run at once and how many bytes they carry.
type slowRemote struct {
	*scriptRemote
	delay func(hash string) time.Duration

	stats       stdsync.Mutex
	active      int
	peak        int
	activeBytes int
	peakBytes   int
	downloads   map[string]int
	uploads     int
	failUpload  map[string]error
}

func newSlowRemote(delay time.Duration) *slowRemote {
	return &slowRemote{scriptRemote: newScriptRemote(), delay: func(string) time.Duration { return delay }, downloads: map[string]int{}}
}

func (r *slowRemote) begin(n int) func() {
	r.stats.Lock()
	r.active++
	r.activeBytes += n
	r.peak, r.peakBytes = max(r.peak, r.active), max(r.peakBytes, r.activeBytes)
	r.stats.Unlock()
	return func() {
		r.stats.Lock()
		r.active--
		r.activeBytes -= n
		r.stats.Unlock()
	}
}

func (r *slowRemote) wait(ctx context.Context, hash string) error {
	select {
	case <-time.After(r.delay(hash)):
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (r *slowRemote) Download(ctx context.Context, hash string, w io.Writer) error {
	r.mu.Lock()
	n := len(r.blobs[hash])
	r.mu.Unlock()
	r.stats.Lock()
	r.downloads[hash]++
	r.stats.Unlock()
	defer r.begin(n)()
	if err := r.wait(ctx, hash); err != nil {
		return err
	}
	return r.scriptRemote.Download(ctx, hash, w)
}

func (r *slowRemote) Upload(ctx context.Context, hash string, data []byte, url string) (string, error) {
	defer r.begin(len(data))()
	r.stats.Lock()
	r.uploads++
	err := r.failUpload[hash]
	r.stats.Unlock()
	if err != nil {
		return "", err
	}
	if err := r.wait(ctx, hash); err != nil {
		return "", err
	}
	return r.scriptRemote.Upload(ctx, hash, data, url)
}

func (r *slowRemote) peaks() (int, int) {
	r.stats.Lock()
	defer r.stats.Unlock()
	return r.peak, r.peakBytes
}

// manifest puts n files of size bytes on the server, listed by its tree.
func (r *slowRemote) manifest(n, size int) map[string][]byte {
	files := map[string][]byte{}
	r.tree = transport.Tree{AsOfSeq: int64(n)}
	for i := range n {
		path := fmt.Sprintf("n%03d.md", i)
		content := append(bytes.Repeat([]byte{byte('a' + i%26)}, size-8), fmt.Sprintf("\n%06d\n", i)...)
		id := newFileID()
		h := r.put(id, 1, content)
		r.tree.Items = append(r.tree.Items, transport.TreeEntry{Path: path, FileID: id, Rev: 1, Hash: h, Size: int64(len(content))})
		files[path] = content
	}
	return files
}

// The first sync of a vault downloads several blobs at once (M12-W6.1), at
// most Config.Transfers, and lands every file; one transfer at a time is
// still available.
func TestBootstrapDownloadsInParallel(t *testing.T) {
	for _, transfers := range []int{0, 1, 3} {
		t.Run(fmt.Sprint(transfers), func(t *testing.T) {
			remote := newSlowRemote(15 * time.Millisecond)
			files := remote.manifest(24, 300)
			e, dir := newTestEngine(t, remote, 0)
			e.cfg.Transfers = transfers
			if err := e.Sync(context.Background()); err != nil {
				t.Fatal(err)
			}
			for path, want := range files {
				if got := readFile(t, dir, path); got != string(want) {
					t.Fatalf("%s = %q, want %q", path, got, want)
				}
			}
			limit := transfers
			if limit == 0 {
				limit = DefaultTransfers
			}
			peak, _ := remote.peaks()
			if peak > limit || (limit > 1 && peak < 2) {
				t.Fatalf("%d downloads at once, want between 2 and %d", peak, limit)
			}
			for h, n := range remote.downloads {
				if n != 1 {
					t.Fatalf("blob %s downloaded %d times", h, n)
				}
			}
		})
	}
}

// The changes of a page are applied in their order whatever order their
// downloads end in: a file created then modified ends with the second
// content, in a shared vault and in a private one (decrypted in the loop).
func TestPullAppliesChangesInOrder(t *testing.T) {
	for _, private := range []bool{false, true} {
		t.Run(fmt.Sprintf("private=%v", private), func(t *testing.T) {
			ctx := context.Background()
			remote := newSlowRemote(0)
			var e *Engine
			var dir string
			if private {
				e, _, dir = newPrivateEngine(t, remote)
			} else {
				e, dir = newTestEngine(t, remote, 0)
			}
			if err := e.cfg.DB.SetMeta(ctx, MetaBootstrapped, "1"); err != nil {
				t.Fatal(err)
			}
			path := "x.md"
			if private {
				path = "enc:x.md" // the fake cipher's path token
			}
			id, other := newFileID(), newFileID()
			first, second := []byte("# first version"), []byte("# second version, smaller blob first")
			h1 := remote.put(id, 1, first)
			h2 := remote.put(id, 2, second)
			hy := remote.put(other, 1, []byte("# y"))
			remote.delay = func(h string) time.Duration {
				if h == h1 {
					return 150 * time.Millisecond // the first blob arrives last
				}
				return 30 * time.Millisecond
			}
			remote.changes = []transport.Change{
				{Seq: 1, FileID: id, Op: "create", Path: path, Rev: 1, BlobHash: h1, Size: int64(len(first))},
				{Seq: 2, FileID: id, Op: "modify", Path: path, Rev: 2, BlobHash: h2, Size: int64(len(second))},
				{Seq: 3, FileID: other, Op: "create", Path: "y.md", Rev: 1, BlobHash: hy, Size: 3},
			}
			if private {
				remote.changes[2].Path = "enc:y.md"
			}
			if err := e.Sync(ctx); err != nil {
				t.Fatal(err)
			}
			if got := readFile(t, dir, "x.md"); got != string(second) {
				t.Fatalf("x.md = %q, want the content of the last change", got)
			}
			row, ok, err := e.cfg.DB.GetFileByID(ctx, id)
			if err != nil || !ok || row.ServerRev != 2 || row.ServerHash != h2 || row.State != StateSynced {
				t.Fatalf("x.md row = %+v (%v, %v), want synced at rev 2", row, ok, err)
			}
			if peak, _ := remote.peaks(); peak < 2 {
				t.Fatalf("%d downloads at once: the page was fetched one blob at a time", peak)
			}
			if cursor(t, e) != 3 {
				t.Fatalf("cursor = %d, want 3", cursor(t, e))
			}
		})
	}
}

// The downloads ahead of the loop hold at most the budget (batchBytes) of
// content, running and downloaded alike, and those the loop did not need
// are dropped when it passes them, each blob being downloaded once.
func TestPrefetchStaysWithinItsBudget(t *testing.T) {
	ctx := context.Background()
	remote := newSlowRemote(3 * time.Millisecond)
	const size, n, budget = 1000, 30, 3500
	var wants []blobWant
	for i := range n {
		content := append(bytes.Repeat([]byte{'p'}, size-4), fmt.Sprintf("%04d", i)...)
		id := newFileID()
		wants = append(wants, blobWant{pos: 2 * i, fileID: id, hash: remote.put(id, 1, content), size: size})
	}
	e, _ := newTestEngine(t, remote, 0)
	e.cfg.Transfers, e.batchBytes = 8, budget
	lctx, stop := e.startPrefetch(ctx, wants)
	defer stop()
	p := lctx.Value(prefetchCtxKey{}).(*prefetcher)
	for pos := 0; pos < 2*n; pos++ {
		advancePrefetch(lctx, pos)
		time.Sleep(time.Millisecond) // let the downloads run ahead
		p.mu.Lock()
		held := p.held
		p.mu.Unlock()
		if held > budget {
			t.Fatalf("at %d: %d bytes held ahead of the loop, budget %d", pos, held, budget)
		}
		w := wants[pos/2]
		if pos%2 == 1 || (pos/2)%5 == 4 {
			continue // a position without a blob, or one whose blob the loop does not need
		}
		data, err := e.fetch(lctx, w.fileID, w.hash, w.size)
		if err != nil || len(data) != size || hashHex(data) != w.hash {
			t.Fatalf("at %d: %d bytes, %v", pos, len(data), err)
		}
	}
	if _, peakBytes := remote.peaks(); peakBytes > budget {
		t.Fatalf("%d bytes downloading at once, budget %d", peakBytes, budget)
	}
	for h, c := range remote.downloads {
		if c != 1 {
			t.Fatalf("blob %s downloaded %d times", h, c)
		}
	}
	stop()
	if p.held != 0 {
		t.Fatalf("%d bytes still held after stop", p.held)
	}
}

// The loop ending early (an error, a cancelled cycle) stops the downloads
// still running instead of waiting for them.
func TestPrefetchStopCancelsDownloads(t *testing.T) {
	remote := newSlowRemote(time.Hour)
	var wants []blobWant
	for i := range 4 {
		id := newFileID()
		wants = append(wants, blobWant{pos: i, fileID: id, hash: remote.put(id, 1, []byte{byte(i)}), size: 1})
	}
	e, _ := newTestEngine(t, remote, 0)
	_, stop := e.startPrefetch(context.Background(), wants)
	deadline := time.Now().Add(5 * time.Second)
	for peak, _ := remote.peaks(); peak < DefaultTransfers && time.Now().Before(deadline); peak, _ = remote.peaks() {
		time.Sleep(time.Millisecond)
	}
	done := make(chan struct{})
	go func() { stop(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("stop waited for downloads that never end")
	}
}

// The blobs of a push batch go up several at once, and the batch is
// committed once they are all up.
func TestPushUploadsInParallel(t *testing.T) {
	remote := newSlowRemote(15 * time.Millisecond)
	e, dir := newTestEngine(t, remote, 0)
	for i := range 12 {
		writeFile(t, dir, fmt.Sprintf("u%02d.md", i), []byte(fmt.Sprintf("# upload %d", i)))
	}
	if err := e.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := len(remote.committed(syncproto.OpCreate, "")); got != 12 {
		t.Fatalf("%d creates committed, want 12", got)
	}
	if peak, _ := remote.peaks(); peak < 2 || peak > DefaultTransfers {
		t.Fatalf("%d uploads at once, want between 2 and %d", peak, DefaultTransfers)
	}
}

// An upload that fails stops the others of its batch, and nothing of the
// batch is committed; the next cycle sends it again.
func TestPushUploadFailureStopsTheBatch(t *testing.T) {
	remote := newSlowRemote(time.Hour) // the others would never end by themselves
	e, dir := newTestEngine(t, remote, 0)
	bad := []byte("# refused by a broken proxy")
	remote.failUpload = map[string]error{hashOf(bad): errors.New("connection reset by peer")}
	writeFile(t, dir, "bad.md", bad)
	for i := range 5 {
		writeFile(t, dir, fmt.Sprintf("ok%d.md", i), []byte(fmt.Sprintf("# fine %d", i)))
	}
	done := make(chan error, 1)
	go func() { done <- e.Sync(context.Background()) }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("a batch whose upload failed synced without an error")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the failed upload did not stop the others")
	}
	remote.mu.Lock()
	sent := len(remote.commits)
	remote.mu.Unlock()
	if sent != 0 {
		t.Fatalf("committed %d operations of a batch whose upload failed", sent)
	}
	remote.failUpload, remote.delay = nil, func(string) time.Duration { return 0 }
	if err := e.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := len(remote.committed(syncproto.OpCreate, "")); got != 6 {
		t.Fatalf("%d creates committed after the retry, want 6", got)
	}
}

// BenchmarkBootstrapLatency is the first sync of a vault of 100 small files
// on a server 20 ms away: one transfer at a time, DefaultTransfers and more.
func BenchmarkBootstrapLatency(b *testing.B) {
	for _, transfers := range []int{1, DefaultTransfers, 8} {
		b.Run(fmt.Sprintf("transfers=%d", transfers), func(b *testing.B) {
			for b.Loop() {
				b.StopTimer()
				remote := newSlowRemote(20 * time.Millisecond)
				remote.manifest(100, 2000)
				e, _ := newTestEngine(b, remote, 0)
				e.cfg.Transfers = transfers
				b.StartTimer()
				if err := e.Sync(context.Background()); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
