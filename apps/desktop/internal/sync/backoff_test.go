package sync

import (
	"testing"
	"time"
)

// After repeated failures (cloud or database down) the engine waits longer and
// longer, never beyond the cap, and never in lockstep with other clients.
func TestErrorBackoffGrowsIsCappedAndJittered(t *testing.T) {
	prev := time.Duration(0)
	for failures := 1; failures <= 12; failures++ {
		base := 5 * time.Second << min(failures-1, 6)
		if base > maxErrorWait {
			base = maxErrorWait
		}
		for i := 0; i < 50; i++ {
			d := errorBackoff(failures)
			if d < base || d > base+base/4 {
				t.Fatalf("failures=%d: %v outside [%v, %v]", failures, d, base, base+base/4)
			}
		}
		if base < prev {
			t.Fatalf("backoff shrank at failure %d", failures)
		}
		prev = base
	}
	if prev != maxErrorWait {
		t.Fatalf("cap not reached: %v", prev)
	}
	distinct := map[time.Duration]bool{}
	for i := 0; i < 50; i++ {
		distinct[errorBackoff(3)] = true
	}
	if len(distinct) < 10 {
		t.Fatalf("jitter too weak: %d distinct waits in 50 draws", len(distinct))
	}
}
