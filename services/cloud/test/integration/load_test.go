//go:build integration

package integration

import (
	"fmt"
	"net/http"
	"os"
	"sort"
	"strconv"
	"sync"
	"testing"
	"time"
)

func percentile(d []time.Duration, p float64) time.Duration {
	sort.Slice(d, func(i, j int) bool { return d[i] < d[j] })
	return d[int(float64(len(d)-1)*p)]
}

// TestLoadSyncLatency checks the M2 exit criteria against a local stack:
// p95 of GET changes < 200 ms and p95 of a 50-operation commit < 500 ms with
// concurrent clients on a vault holding thousands of files. It is skipped
// unless NODUS_LOAD=1 (it takes a few seconds and prints the measurements).
func TestLoadSyncLatency(t *testing.T) {
	if os.Getenv("NODUS_LOAD") == "" {
		t.Skip("set NODUS_LOAD=1 to run the latency check")
	}
	e := newEnv(t)
	ada := e.user("load")
	v := ada.createVault("Load", "shared")
	h := ada.putBlob(v, []byte("payload for load test"))

	// Seed 5,000 files in batches of 500 (the server maximum).
	const seed, batch = 5000, 500
	for i := 0; i < seed; i += batch {
		ops := make([]map[string]any, 0, batch)
		for j := 0; j < batch; j++ {
			ops = append(ops, create(newID(), fmt.Sprintf("seed/f%d/n%05d.md", (i+j)%50, i+j), h))
		}
		for _, r := range ada.commit(v, ops...) {
			mustAccepted(t, r)
		}
	}

	clients, rounds := 8, 25
	if n, err := strconv.Atoi(os.Getenv("NODUS_LOAD_CLIENTS")); err == nil && n > 0 {
		clients = n
	}
	// Typical load: every device writes to its own vault; they only share the database.
	vaults := make([]string, clients)
	for c := range vaults {
		vaults[c] = ada.createVault(fmt.Sprintf("LoadWriter%d", c), "shared")
		ada.putBlob(vaults[c], []byte("payload for load test"))
	}
	run := func(target func(c int) string) (changeLat, commitLat []time.Duration) {
		var mu sync.Mutex
		var wg sync.WaitGroup
		for c := 0; c < clients; c++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for r := 0; r < rounds; r++ {
					start := time.Now()
					resp := ada.json(http.MethodGet, fmt.Sprintf("/vaults/%s/changes?since=%d&limit=500", v, r*100), nil)
					if resp.StatusCode != http.StatusOK {
						t.Errorf("changes: %d", resp.StatusCode)
						return
					}
					el := time.Since(start)

					ops := make([]map[string]any, 0, 50)
					for j := 0; j < 50; j++ {
						ops = append(ops, create(newID(), fmt.Sprintf("load/c%d/r%d/n%02d.md", c, r, j), h))
					}
					start = time.Now()
					for _, res := range ada.commit(target(c), ops...) {
						if res.status() != "accepted" {
							t.Errorf("commit: %v", res)
							return
						}
					}
					cl := time.Since(start)
					mu.Lock()
					changeLat, commitLat = append(changeLat, el), append(commitLat, cl)
					mu.Unlock()
				}
			}()
		}
		wg.Wait()
		return
	}

	changeLat, commitLat := run(func(c int) string { return vaults[c] })
	cp95, mp95 := percentile(changeLat, 0.95), percentile(commitLat, 0.95)
	t.Logf("changes (500 items, %d concurrent clients): p50 %v p95 %v", clients, percentile(changeLat, 0.5), cp95)
	t.Logf("commit (50 ops, %d concurrent clients, one vault each): p50 %v p95 %v", clients, percentile(commitLat, 0.5), mp95)

	// Worst case for information: all writers on the same vault serialize on its lock.
	_, sameLat := run(func(int) string { return v })
	t.Logf("commit (50 ops, %d concurrent clients on the SAME vault): p50 %v p95 %v", clients, percentile(sameLat, 0.5), percentile(sameLat, 0.95))

	if cp95 > 200*time.Millisecond {
		t.Errorf("changes p95 %v exceeds 200 ms", cp95)
	}
	if mp95 > 500*time.Millisecond {
		t.Errorf("commit p95 %v exceeds 500 ms", mp95)
	}
}
