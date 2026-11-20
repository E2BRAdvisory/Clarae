//go:build !js

package terminal

import "unicode/utf8"

// ring keeps the last max bytes written to it. It is not safe for concurrent use: the session
// guards it.
type ring struct {
	buf   []byte
	start int // index of the oldest byte
	n     int // bytes held
	max   int
}

func newRing(max int) *ring { return &ring{max: max} }

// write appends p, dropping the oldest bytes beyond max.
func (r *ring) write(p []byte) {
	if len(p) >= r.max {
		r.buf = append(r.buf[:0], p[len(p)-r.max:]...)
		r.start, r.n = 0, r.max
		return
	}
	if r.n+len(p) <= len(r.buf) || len(r.buf) >= r.max {
		// Room in the allocated part (or all of it allocated): write at the end, wrapping.
		r.put(p)
		return
	}
	// Grow, unwrapping what is there, up to max.
	size := min(max(2*len(r.buf), r.n+len(p), 4096), r.max)
	nb := make([]byte, size)
	copy(nb, r.bytes())
	r.buf, r.start = nb, 0
	r.put(p)
}

// put writes p when len(r.buf) is the capacity in use; it may overwrite the oldest bytes.
func (r *ring) put(p []byte) {
	c := len(r.buf)
	end := (r.start + r.n) % c
	for len(p) > 0 {
		k := copy(r.buf[end:], p)
		p = p[k:]
		end = (end + k) % c
		r.n += k
	}
	if r.n > c {
		r.start = (r.start + r.n - c) % c
		r.n = c
	}
}

// bytes returns the content, oldest first, in a new slice.
func (r *ring) bytes() []byte {
	out := make([]byte, r.n)
	if r.n == 0 {
		return out
	}
	c := len(r.buf)
	first := min(r.n, c-r.start)
	copy(out, r.buf[r.start:r.start+first])
	copy(out[first:], r.buf[:r.n-first])
	return out
}

// text returns the content as a string that starts on a character boundary: the cut that dropping
// the oldest bytes made may have left the tail of a multibyte sequence in front.
func (r *ring) text() string {
	b := r.bytes()
	i := 0
	for i < len(b) && i < utf8.UTFMax && !utf8.RuneStart(b[i]) {
		i++
	}
	return string(b[i:])
}
