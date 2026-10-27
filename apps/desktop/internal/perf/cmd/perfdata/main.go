// Command perfdata generates (or reuses) a synthetic vault for the performance suite.
//
//	go run ./internal/perf/cmd/perfdata -notes 50000 -dir .perf/vault-50000
package main

import (
	"flag"
	"fmt"
	"os"
	"time"

	"nodus/apps/desktop/internal/perf/dataset"
)

func main() {
	notes := flag.Int("notes", 50000, "number of notes")
	seed := flag.Uint64("seed", 1, "generator seed")
	dir := flag.String("dir", "", "target directory (required)")
	flag.Parse()
	if *dir == "" {
		fmt.Fprintln(os.Stderr, "-dir is required")
		os.Exit(2)
	}
	start := time.Now()
	m, err := dataset.Ensure(*dir, dataset.Config{Notes: *notes, Seed: *seed})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Printf("vault %s: %d notes, %.1f MB, %d links, %d attachments (%s)\n", *dir, m.Notes, float64(m.Bytes)/1e6, m.Links, m.Attachments, time.Since(start).Round(time.Millisecond))
}
