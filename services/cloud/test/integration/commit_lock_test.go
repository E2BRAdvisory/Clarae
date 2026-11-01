//go:build integration

package integration

import (
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// commitFallbacks sums memobrain_sync_commit_fallbacks_total over its labels
// (the server runs in process: same default registry).
func commitFallbacks(t *testing.T) (total float64, byReason map[string]float64) {
	t.Helper()
	families, err := prometheus.DefaultGatherer.Gather()
	if err != nil {
		t.Fatal(err)
	}
	byReason = map[string]float64{}
	for _, f := range families {
		if f.GetName() != "memobrain_sync_commit_fallbacks_total" {
			continue
		}
		for _, m := range f.GetMetric() {
			v := m.GetCounter().GetValue()
			total += v
			for _, l := range m.GetLabel() {
				if l.GetName() == "reason" {
					byReason[l.GetValue()] += v
				}
			}
		}
	}
	return total, byReason
}

// Batches that modify overlapping files in different orders used to lock a
// file row, then the vault row (NextVaultSeq), then the next file: two of
// them deadlocked, PostgreSQL aborted one (40P01) and the request was
// replayed op by op on the slow path. With the vault row locked first the
// batches queue on it: every request succeeds on the fast path, and each
// file has exactly one winner per round.
func TestConcurrentOverlappingBatchesDoNotDeadlock(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createVault("Overlap", "shared")
	const files, writers, rounds = 6, 4, 12
	ids := make([]string, files)
	h0 := ada.putBlob(v, []byte("base"))
	var creates []map[string]any
	for i := range ids {
		ids[i] = newID()
		creates = append(creates, create(ids[i], fmt.Sprintf("f%d.md", i), h0))
	}
	for _, r := range ada.commit(v, creates...) {
		mustAccepted(t, r)
	}
	hashes := make([]string, writers)
	for w := range hashes {
		hashes[w] = ada.putBlob(v, []byte(fmt.Sprintf("writer %d", w)))
	}
	// order returns writer w's file order: forward, backward, rotated.
	order := func(w int) []int {
		out := make([]int, files)
		for i := range out {
			k := (i + w*files/writers) % files
			if w%2 == 1 {
				k = files - 1 - k
			}
			out[i] = k
		}
		return out
	}
	before, _ := commitFallbacks(t)
	start := time.Now()
	for round := range rounds {
		paths, _ := ada.tree(v)
		revs := make([]int, files)
		for i := range revs {
			revs[i] = int(paths[fmt.Sprintf("f%d.md", i)]["rev"].(float64))
		}
		accepted := make([][]bool, writers)
		var wg sync.WaitGroup
		for w := range writers {
			wg.Add(1)
			go func() {
				defer wg.Done()
				var ops []map[string]any
				ord := order(w)
				for _, i := range ord {
					ops = append(ops, modify(ids[i], revs[i], hashes[w]))
				}
				res := ada.commit(v, ops...)
				accepted[w] = make([]bool, files)
				for k, r := range res {
					accepted[w][ord[k]] = r.status() == "accepted"
				}
			}()
		}
		wg.Wait()
		if t.Failed() {
			t.FailNow()
		}
		for i := range files {
			winners := 0
			for w := range writers {
				if accepted[w][i] {
					winners++
				}
			}
			if winners != 1 {
				t.Fatalf("round %d: file %d has %d winners, want 1", round, i, winners)
			}
		}
	}
	after, byReason := commitFallbacks(t)
	if after != before {
		t.Errorf("%v commit batches fell back to the slow path (by reason, cumulative: %v)", after-before, byReason)
	}
	t.Logf("%d rounds of %d overlapping batches in %v", rounds, writers, time.Since(start))
}
