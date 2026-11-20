//go:build !js

package terminal

import (
	"bytes"
	"math/rand/v2"
	"testing"
)

// The ring keeps the last max bytes, whatever the sizes of the writes.
func TestRingKeepsTheTail(t *testing.T) {
	rng := rand.New(rand.NewPCG(1, 2)) //nolint:gosec // G404: a repeatable sequence for a test, not a secret
	for _, max := range []int{1, 7, 64, 5000} {
		r := newRing(max)
		var model []byte
		for range 300 {
			n := rng.IntN(max*2 + 3)
			p := make([]byte, n)
			for i := range p {
				p[i] = byte(rng.IntN(256)) //nolint:gosec // G115: below 256
			}
			r.write(p)
			model = append(model, p...)
			if len(model) > max {
				model = model[len(model)-max:]
			}
			if got := r.bytes(); !bytes.Equal(got, model) {
				t.Fatalf("max %d: ring holds %d bytes, model %d, or they differ", max, len(got), len(model))
			}
		}
	}
}

// A snapshot starts on a character: dropping the oldest bytes must not leave half of one in front.
func TestRingTextStartsOnACharacter(t *testing.T) {
	r := newRing(5)
	r.write([]byte("a€cde")) // 1 + 3 + 3 = 7 bytes: the cut falls inside the euro sign
	if got := r.text(); got != "cde" {
		t.Fatalf("text() = %q, want %q", got, "cde")
	}
	r2 := newRing(100)
	r2.write([]byte("héllo"))
	if got := r2.text(); got != "héllo" {
		t.Fatalf("text() = %q", got)
	}
}
