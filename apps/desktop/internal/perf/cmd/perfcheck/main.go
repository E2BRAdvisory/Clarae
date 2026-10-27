// Command perfcheck compares a flat JSON map of measurements (as written by
// the perf suite via MEMOBRAIN_PERF_OUT) with a stored baseline and fails when a
// metric regressed by more than the allowed percentage. Every metric is "lower
// is better" (milliseconds, seconds, megabytes).
//
//	go run ./internal/perf/cmd/perfcheck -baseline ../../docs/perf/baseline-50000.json -results perf.json -tolerance 25
//
// The baseline file looks like {"meta": {...}, "metrics": {"name": value}}.
// Metrics missing from the results are reported; metrics missing from the
// baseline are informational. Tiny absolute values are ignored (-floor) so
// that timer noise on sub-millisecond metrics cannot fail a night.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"
)

type baseline struct {
	Meta    map[string]any     `json:"meta"`
	Metrics map[string]float64 `json:"metrics"`
}

func main() {
	basePath := flag.String("baseline", "", "baseline JSON (required)")
	resPath := flag.String("results", "", "results JSON (required)")
	tol := flag.Float64("tolerance", 25, "allowed regression in percent")
	floor := flag.Float64("floor", 2, "ignore regressions whose absolute increase is below this value")
	flag.Parse()
	if *basePath == "" || *resPath == "" {
		fmt.Fprintln(os.Stderr, "-baseline and -results are required")
		os.Exit(2)
	}
	var base baseline
	var res map[string]float64
	read := func(p string, v any) {
		raw, err := os.ReadFile(p)
		if err == nil {
			err = json.Unmarshal(raw, v)
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
	}
	read(*basePath, &base)
	read(*resPath, &res)

	names := make([]string, 0, len(base.Metrics))
	for n := range base.Metrics {
		names = append(names, n)
	}
	sort.Strings(names)
	failed := 0
	for _, n := range names {
		if strings.HasPrefix(n, "dataset_") || n == "notes" {
			continue
		}
		want := base.Metrics[n]
		got, ok := res[n]
		if !ok {
			fmt.Printf("MISSING %-40s baseline %.2f\n", n, want)
			failed++
			continue
		}
		limit := want * (1 + *tol/100)
		status := "ok     "
		if got > limit && got-want > *floor {
			status = "REGRESS"
			failed++
		}
		fmt.Printf("%s %-40s baseline %10.2f  now %10.2f  (%+.0f%%)\n", status, n, want, got, pct(want, got))
	}
	if failed > 0 {
		fmt.Printf("\n%d metric(s) beyond the %.0f%% budget\n", failed, *tol)
		os.Exit(1)
	}
	fmt.Printf("\nall %d metrics within the %.0f%% budget\n", len(names), *tol)
}

func pct(a, b float64) float64 {
	if a == 0 {
		return 0
	}
	return (b - a) / a * 100
}
