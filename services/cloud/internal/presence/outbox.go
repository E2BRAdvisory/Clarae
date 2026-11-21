package presence

import "sync"

// maxControlQueue bounds the control frames (joined, left, members, errors)
// waiting for a client that stopped reading; past it the connection is closed
// as a slow consumer. Moves never pile up: only the latest per sender counts.
const maxControlQueue = 512

type moveKey struct {
	room Room
	sid  string
}

// outbox is the mailbox of one connection: control frames in order, move
// frames latest-wins per (room, sender), so a slow client never builds a backlog
// of positions.
type outbox struct {
	mu       sync.Mutex
	ctl      [][]byte
	moves    map[moveKey][]byte
	order    []moveKey
	closed   bool
	overflow bool
	signal   chan struct{}
}

func newOutbox() *outbox {
	return &outbox{moves: map[moveKey][]byte{}, signal: make(chan struct{}, 1)}
}

func (o *outbox) wake() {
	select {
	case o.signal <- struct{}{}:
	default:
	}
}

func (o *outbox) control(f []byte) {
	o.mu.Lock()
	if o.closed {
		o.mu.Unlock()
		return
	}
	if len(o.ctl) >= maxControlQueue {
		o.overflow = true
	} else {
		o.ctl = append(o.ctl, f)
	}
	o.mu.Unlock()
	o.wake()
}

func (o *outbox) move(k moveKey, f []byte) {
	o.mu.Lock()
	if o.closed {
		o.mu.Unlock()
		return
	}
	if _, ok := o.moves[k]; !ok {
		o.order = append(o.order, k)
	}
	o.moves[k] = f
	o.mu.Unlock()
	o.wake()
}

// forget drops the moves queued for a room (after a kick, nothing of it may be sent).
func (o *outbox) forget(room Room) {
	o.mu.Lock()
	defer o.mu.Unlock()
	keep := o.order[:0]
	for _, k := range o.order {
		if k.room == room {
			delete(o.moves, k)
		} else {
			keep = append(keep, k)
		}
	}
	o.order = keep
}

func (o *outbox) close() {
	o.mu.Lock()
	o.closed = true
	o.ctl, o.moves, o.order = nil, map[moveKey][]byte{}, nil
	o.mu.Unlock()
	o.wake()
}

// takeControl returns and clears the control frames; overflow reports that
// frames were dropped.
func (o *outbox) takeControl() (frames [][]byte, overflow bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	frames, o.ctl = o.ctl, nil
	return frames, o.overflow
}

func (o *outbox) hasMoves() bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	return len(o.order) > 0
}

// takeMoves returns the latest frame of every sender and clears them.
func (o *outbox) takeMoves() [][]byte {
	o.mu.Lock()
	defer o.mu.Unlock()
	out := make([][]byte, 0, len(o.order))
	for _, k := range o.order {
		out = append(out, o.moves[k])
	}
	o.order = nil
	o.moves = map[moveKey][]byte{}
	return out
}

func (o *outbox) isClosed() bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.closed
}
