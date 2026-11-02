package jobs

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/rs/zerolog"
)

// A failing maintenance step must not skip the ones after it: a broken
// compaction used to leave deleted vaults unpurged and quotas unreconciled.
func TestRunStepsContinuesAfterAFailure(t *testing.T) {
	r := &Runner{log: zerolog.Nop()}
	boom := errors.New("boom")
	var ran []string
	record := func(name string, err error) step {
		return step{name, func(context.Context) error { ran = append(ran, name); return err }}
	}
	err := r.runSteps(context.Background(), []step{
		record("compaction", boom),
		record("purge-vaults", nil),
		record("reconcile-usage", boom),
		record("storage-snapshot", nil),
	})
	if len(ran) != 4 {
		t.Fatalf("ran %v, want every step", ran)
	}
	if !errors.Is(err, boom) {
		t.Fatalf("error %v does not wrap the step failure", err)
	}
	for _, name := range []string{"compaction", "reconcile-usage"} {
		if !strings.Contains(err.Error(), name) {
			t.Errorf("error %q does not name the failed step %s", err, name)
		}
	}
}

func TestRunStepsStopsWhenTheContextEnds(t *testing.T) {
	r := &Runner{log: zerolog.Nop()}
	ctx, cancel := context.WithCancel(context.Background())
	ran := 0
	err := r.runSteps(ctx, []step{
		{"first", func(context.Context) error { ran++; cancel(); return nil }},
		{"second", func(context.Context) error { ran++; return nil }},
	})
	if ran != 1 || err != nil {
		t.Fatalf("ran %d steps (err %v), want only the first", ran, err)
	}
}

// An interrupted run is neither a failure nor a success: recording it as a
// success would refresh the job's last success and hide a stalled job.
func TestRunOutcome(t *testing.T) {
	boom := errors.New("boom")
	for name, c := range map[string]struct {
		err, ctxErr error
		want        int
	}{
		"success":                      {nil, nil, runSucceeded},
		"failure":                      {boom, nil, runFailed},
		"interrupted with an error":    {context.Canceled, context.Canceled, runInterrupted},
		"interrupted without an error": {nil, context.Canceled, runInterrupted},
	} {
		if got := runOutcome(c.err, c.ctxErr); got != c.want {
			t.Errorf("%s: outcome %d, want %d", name, got, c.want)
		}
	}
}
