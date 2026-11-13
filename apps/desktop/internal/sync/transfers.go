package sync

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	stdsync "sync"

	"clarae/apps/desktop/internal/sync/transport"
)

// Blob transfers (M12-W6.1). A cycle applies the changes one after the other,
// in the order of the changelog or of the manifest, and writes sync.db in
// that order: only the network part runs ahead. The downloads a page of
// changes (or a bootstrap) will need are started in the background, at most
// Config.Transfers at once and at most batchBytes of content ahead (the
// bound of a push batch, W0.4), and the apply loop picks each blob up when
// it reaches its change. The uploads of a push batch, already in memory, go
// up Config.Transfers at once before the batch is committed.

// DefaultTransfers is how many blobs a cycle transfers at once when
// Config.Transfers is not set: enough to hide the round trip of small files
// on a distant server, few enough for the browser core (one JavaScript
// thread, a handful of connections per host) and for the server.
const DefaultTransfers = 4

// prefetchAhead bounds how many positions of the apply loop the downloads
// run ahead of it, whatever their size: a failure of the loop wastes little.
const prefetchAhead = 64

func (e *Engine) transfers() int {
	if e.cfg.Transfers > 0 {
		return e.cfg.Transfers
	}
	return DefaultTransfers
}

// download reads a blob and verifies its digest. size is the blob size the
// changelog or the manifest announced (0 = unknown): a download that goes
// past it fails before it is all in memory.
func (e *Engine) download(ctx context.Context, hash string, size int64) ([]byte, error) {
	var buf bytes.Buffer
	if size > 0 && size <= maxBatchBytes {
		// Room for the content and the read that finds its end, so the
		// buffer never doubles past it.
		buf.Grow(int(size) + bytes.MinRead)
	}
	if err := e.cfg.Remote.Download(transport.WithExpectedSize(ctx, size), hash, &buf); err != nil {
		return nil, err
	}
	sum := sha256.Sum256(buf.Bytes())
	if hex.EncodeToString(sum[:]) != hash {
		return nil, fmt.Errorf("blob %s: content does not match its digest", hash)
	}
	return buf.Bytes(), nil
}

// blobWant is a blob the apply loop is expected to fetch at position pos.
type blobWant struct {
	pos          int
	fileID, hash string
	size         int64
}

type prefetchKey struct{ fileID, hash string }

// Prefetch states.
const (
	pfWaiting = iota // not started yet
	pfRunning        // downloading
	pfDone           // downloaded (or failed), not picked up yet
	pfGone           // picked up, passed by the loop, or taken over by a direct download
)

type prefetchItem struct {
	blobWant
	state int
	held  int64 // bytes of the budget it holds (running or done)
	data  []byte
	err   error
	done  chan struct{} // closed when the download ends
	stop  context.CancelFunc
}

// prefetcher downloads the blobs an apply loop will need ahead of it. The
// loop owns it: take and advance are called by the loop only, in order.
type prefetcher struct {
	e       *Engine
	ctx     context.Context
	cancel  context.CancelFunc
	workers int
	budget  int64
	wg      stdsync.WaitGroup
	wake    chan struct{}

	mu      stdsync.Mutex
	items   []*prefetchItem
	byKey   map[prefetchKey][]*prefetchItem
	passed  int   // items[:passed] are behind the loop
	pos     int   // the loop is at this position
	held    int64 // content held by running and done items
	running int
}

type prefetchCtxKey struct{}

// startPrefetch starts downloading wants (in the order of their positions)
// and returns the context through which fetch finds them. stop cancels what
// is left and waits for it; it must be called before the loop returns.
func (e *Engine) startPrefetch(ctx context.Context, wants []blobWant) (context.Context, func()) {
	if len(wants) == 0 || e.transfers() <= 1 {
		return ctx, func() {}
	}
	pctx, cancel := context.WithCancel(ctx)
	p := &prefetcher{
		e: e, ctx: pctx, cancel: cancel, workers: e.transfers(), budget: int64(e.batchBytes),
		wake: make(chan struct{}, 1), byKey: make(map[prefetchKey][]*prefetchItem, len(wants)),
	}
	p.items = make([]*prefetchItem, len(wants))
	for i, w := range wants {
		it := &prefetchItem{blobWant: w, done: make(chan struct{})}
		p.items[i] = it
		k := prefetchKey{w.fileID, w.hash}
		p.byKey[k] = append(p.byKey[k], it)
	}
	p.wg.Add(1)
	go p.run()
	return context.WithValue(ctx, prefetchCtxKey{}, p), p.close
}

func (p *prefetcher) signal() {
	select {
	case p.wake <- struct{}{}:
	default:
	}
}

// reserve is what a download holds of the budget until it ends: its size,
// or the whole budget when the size is unknown (it then runs alone).
func (p *prefetcher) reserve(it *prefetchItem) int64 {
	if it.size > 0 {
		return it.size
	}
	return p.budget
}

// run starts the downloads in order, as workers and budget allow.
func (p *prefetcher) run() {
	defer p.wg.Done()
	for next := 0; next < len(p.items) && p.ctx.Err() == nil; {
		p.mu.Lock()
		it := p.items[next]
		if it.state != pfWaiting || it.pos < p.pos {
			if it.state == pfWaiting {
				it.state = pfGone // the loop is past it
			}
			p.mu.Unlock()
			next++
			continue
		}
		r := p.reserve(it)
		if p.running >= p.workers || it.pos >= p.pos+prefetchAhead || (p.held > 0 && p.held+r > p.budget) {
			p.mu.Unlock()
			select {
			case <-p.wake:
				continue
			case <-p.ctx.Done():
				return
			}
		}
		ctx, stop := context.WithCancel(p.ctx)
		it.state, it.held, it.stop = pfRunning, r, stop
		p.held += r
		p.running++
		p.mu.Unlock()
		p.wg.Add(1)
		go p.fetch(ctx, it)
		next++
	}
}

func (p *prefetcher) fetch(ctx context.Context, it *prefetchItem) {
	defer p.wg.Done()
	data, err := p.e.download(ctx, it.hash, it.size)
	p.mu.Lock()
	it.stop()
	p.running--
	if it.state == pfGone { // passed by the loop meanwhile
		p.held -= it.held
		it.held = 0
	} else {
		// From here it holds what it really read.
		p.held += int64(len(data)) - it.held
		it.held = int64(len(data))
		it.data, it.err, it.state = data, err, pfDone
	}
	close(it.done)
	p.mu.Unlock()
	p.signal()
}

// take returns the blob downloaded for the change at the loop's position
// (ok), or ok false when it was not prefetched, in which case the caller
// downloads it itself (and the prefetcher will not).
//
// The blob of the loop's own position is always awaited, even when its
// download has not started yet: the downloads start in order and everything
// before that position is dropped (advance), so it is the next to start,
// and the transfers never exceed Config.Transfers. A blob of a later
// position (the same file and content twice in a page) is downloaded by the
// caller instead: waiting for it could wait for the budget the positions
// before it hold.
func (p *prefetcher) take(ctx context.Context, fileID, hash string) (data []byte, ok bool, err error) {
	p.mu.Lock()
	var it *prefetchItem
	k := prefetchKey{fileID, hash}
	for _, c := range p.byKey[k] {
		if c.state != pfGone {
			it = c
			break
		}
	}
	if it == nil {
		p.mu.Unlock()
		return nil, false, nil
	}
	if it.state == pfWaiting && it.pos > p.pos {
		it.state = pfGone
		p.mu.Unlock()
		return nil, false, nil
	}
	p.mu.Unlock()
	select {
	case <-it.done:
	case <-ctx.Done():
		return nil, true, ctx.Err()
	}
	p.mu.Lock()
	data, err = it.data, it.err
	it.data, it.err, it.state = nil, nil, pfGone
	p.held -= it.held
	it.held = 0
	p.mu.Unlock()
	p.signal()
	return data, true, err
}

// advance tells that the loop is now at position pos: what was downloaded
// for the positions before it and not picked up is dropped (the loop did not
// need it), and the downloads may run further ahead.
func (p *prefetcher) advance(pos int) {
	p.mu.Lock()
	p.pos = pos
	for ; p.passed < len(p.items) && p.items[p.passed].pos < pos; p.passed++ {
		it := p.items[p.passed]
		switch it.state {
		case pfWaiting:
			it.state = pfGone
		case pfRunning:
			it.state = pfGone
			it.stop() // fetch releases its bytes when it returns
		case pfDone:
			p.held -= it.held
			it.held, it.data, it.err, it.state = 0, nil, nil, pfGone
		}
	}
	p.mu.Unlock()
	p.signal()
}

// close stops the downloads still running, waits for them and drops what
// was not picked up.
func (p *prefetcher) close() {
	p.cancel()
	p.wg.Wait()
	p.mu.Lock()
	for _, it := range p.items {
		p.held -= it.held
		it.held, it.data, it.err, it.state = 0, nil, nil, pfGone
	}
	p.mu.Unlock()
}

// prefetched returns the blob downloaded ahead for the loop of ctx, if any.
func prefetched(ctx context.Context, fileID, hash string) ([]byte, bool, error) {
	p, _ := ctx.Value(prefetchCtxKey{}).(*prefetcher)
	if p == nil {
		return nil, false, nil
	}
	return p.take(ctx, fileID, hash)
}

// advancePrefetch is advance for the loop of ctx (a no-op without prefetch).
func advancePrefetch(ctx context.Context, pos int) {
	if p, _ := ctx.Value(prefetchCtxKey{}).(*prefetcher); p != nil {
		p.advance(pos)
	}
}

// runLimited calls fn for 0..n-1, at most limit at once, and returns when
// all calls returned. A call that fails cancels the context of the others;
// the first such error is returned.
func runLimited(ctx context.Context, n, limit int, fn func(ctx context.Context, i int) error) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var (
		wg    stdsync.WaitGroup
		mu    stdsync.Mutex
		first error
	)
	slots := make(chan struct{}, max(limit, 1))
	for i := range n {
		select {
		case slots <- struct{}{}:
		case <-ctx.Done():
		}
		if ctx.Err() != nil {
			break
		}
		wg.Add(1)
		go func() {
			defer func() { <-slots; wg.Done() }()
			if err := fn(ctx, i); err != nil {
				mu.Lock()
				if first == nil {
					first = err
				}
				mu.Unlock()
				cancel()
			}
		}()
	}
	wg.Wait()
	if first == nil {
		first = ctx.Err()
	}
	return first
}
