//go:build integration

package integration

import (
	"fmt"
	"net/http"
	"os"
	"runtime/pprof"
	"strconv"
	"sync"
	"testing"
	"time"
)

// TestLoadSmallOps drives the realistic mix of 1,000 active users in-process:
// many users, each with its own vault, polling `changes` at their cursor and
// committing one small file now and then. It reports throughput and
// percentiles and can write a CPU profile of the server side:
//
//	CLARAE_LOAD=1 CLARAE_LOAD_USERS=200 CLARAE_LOAD_SECONDS=15 CLARAE_LOAD_CPUPROFILE=cpu.pprof \
//	  go test -tags integration -run TestLoadSmallOps -v ./test/integration/
//
// Closed loop without think time: the throughput it reaches is far above what
// 1,000 real users generate (about 100 requests/s), so p95 here is a safe
// upper bound. See docs/perf/README.md.
func TestLoadSmallOps(t *testing.T) {
	if os.Getenv("CLARAE_LOAD") == "" {
		t.Skip("set CLARAE_LOAD=1 to run the small-operations load test")
	}
	users, seconds := 200, 15
	if n, err := strconv.Atoi(os.Getenv("CLARAE_LOAD_USERS")); err == nil && n > 0 {
		users = n
	}
	if n, err := strconv.Atoi(os.Getenv("CLARAE_LOAD_SECONDS")); err == nil && n > 0 {
		seconds = n
	}
	e := newEnv(t)
	type actor struct {
		c       *client
		vault   string
		hash    string
		file    string
		rev     int
		cursor  float64
		counter int
	}
	actors := make([]*actor, users)
	var setup sync.WaitGroup
	sem := make(chan struct{}, 16)
	for i := range actors {
		setup.Add(1)
		sem <- struct{}{}
		go func() {
			defer setup.Done()
			defer func() { <-sem }()
			c := e.user(fmt.Sprintf("small%04d", i))
			v := c.createVault("Small", "shared")
			h := c.putBlob(v, []byte("seed"))
			id := newID()
			rs := c.commit(v, create(id, "notes/a.md", h))
			mustAccepted(t, rs[0])
			actors[i] = &actor{c: c, vault: v, hash: h, file: id, rev: rs[0].rev()}
		}()
	}
	setup.Wait()

	if prof := os.Getenv("CLARAE_LOAD_CPUPROFILE"); prof != "" {
		f, err := os.Create(prof) //nolint:gosec // developer-chosen output path
		if err != nil {
			t.Fatal(err)
		}
		if err := pprof.StartCPUProfile(f); err != nil {
			t.Fatal(err)
		}
		defer func() { pprof.StopCPUProfile(); _ = f.Close() }()
	}

	var mu sync.Mutex
	var changeLat, commitLat []time.Duration
	deadline := time.Now().Add(time.Duration(seconds) * time.Second)
	var wg sync.WaitGroup
	for _, a := range actors {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for time.Now().Before(deadline) {
				start := time.Now()
				resp := a.c.json(http.MethodGet, fmt.Sprintf("/vaults/%s/changes?since=%d&limit=500", a.vault, int64(a.cursor)), nil)
				if resp.StatusCode != http.StatusOK {
					t.Errorf("changes: %d", resp.StatusCode)
					return
				}
				body := decode[map[string]any](t, resp)
				a.cursor, _ = body["next_seq"].(float64)
				el := time.Since(start)
				mu.Lock()
				changeLat = append(changeLat, el)
				mu.Unlock()

				a.counter++
				if a.counter%3 != 0 {
					continue
				}
				h := a.c.putBlob(a.vault, []byte(fmt.Sprintf("edit %s %d", a.vault, a.counter)))
				start = time.Now()
				res := a.c.commit(a.vault, modify(a.file, a.rev, h))
				if res[0].status() != "accepted" {
					t.Errorf("commit: %v", res[0])
					return
				}
				a.rev = res[0].rev()
				el = time.Since(start)
				mu.Lock()
				commitLat = append(commitLat, el)
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	t.Logf("%d users, %ds: changes n=%d (%.0f/s) p50 %v p95 %v p99 %v", users, seconds, len(changeLat), float64(len(changeLat))/float64(seconds),
		percentile(changeLat, 0.5), percentile(changeLat, 0.95), percentile(changeLat, 0.99))
	t.Logf("%d users, %ds: commit (1 op) n=%d (%.0f/s) p50 %v p95 %v p99 %v", users, seconds, len(commitLat), float64(len(commitLat))/float64(seconds),
		percentile(commitLat, 0.5), percentile(commitLat, 0.95), percentile(commitLat, 0.99))
	if p := percentile(changeLat, 0.95); p > 200*time.Millisecond {
		t.Errorf("changes p95 %v exceeds 200 ms", p)
	}
	if p := percentile(commitLat, 0.95); p > 500*time.Millisecond {
		t.Errorf("commit p95 %v exceeds 500 ms", p)
	}
}
