package observability

import (
	"errors"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
)

func TestSyncCommit(t *testing.T) {
	ok := testutil.ToFloat64(syncCommits.WithLabelValues("ok"))
	bad := testutil.ToFloat64(syncCommits.WithLabelValues("error"))
	acc := testutil.ToFloat64(syncOps.WithLabelValues("accepted"))
	SyncCommit(nil, []string{"accepted", "accepted", "conflict"})
	SyncCommit(errors.New("boom"), nil)
	if got := testutil.ToFloat64(syncCommits.WithLabelValues("ok")) - ok; got != 1 {
		t.Fatalf("ok commits +%v", got)
	}
	if got := testutil.ToFloat64(syncCommits.WithLabelValues("error")) - bad; got != 1 {
		t.Fatalf("error commits +%v", got)
	}
	if got := testutil.ToFloat64(syncOps.WithLabelValues("accepted")) - acc; got != 2 {
		t.Fatalf("accepted ops +%v", got)
	}
}

func TestStreamsGauge(t *testing.T) {
	before := testutil.ToFloat64(streams)
	StreamOpened()
	StreamOpened()
	StreamClosed()
	if got := testutil.ToFloat64(streams) - before; got != 1 {
		t.Fatalf("streams +%v", got)
	}
}

func TestJobRun(t *testing.T) {
	JobRun("unit-job", time.Second, nil)
	JobRun("unit-job", time.Second, errors.New("x"))
	if testutil.ToFloat64(jobRuns.WithLabelValues("unit-job", "ok")) != 1 || testutil.ToFloat64(jobRuns.WithLabelValues("unit-job", "error")) != 1 {
		t.Fatal("run counters")
	}
	if testutil.ToFloat64(jobLastSuccess.WithLabelValues("unit-job")) == 0 {
		t.Fatal("last success not set")
	}
}

func TestJobItemFailed(t *testing.T) {
	JobItemFailed("unit-job")
	JobItemFailed("unit-job")
	if got := testutil.ToFloat64(jobItemFailures.WithLabelValues("unit-job")); got != 2 {
		t.Fatalf("item failures %v", got)
	}
}

// The pool collector's descriptors must be valid and unique (checked by a pedantic registry).
func TestPoolDescriptors(t *testing.T) {
	reg := prometheus.NewPedanticRegistry()
	if err := reg.Register(descriptorsOnly{}); err != nil {
		t.Fatal(err)
	}
}

type descriptorsOnly struct{}

func (descriptorsOnly) Describe(ch chan<- *prometheus.Desc) { poolCollector{}.Describe(ch) }
func (descriptorsOnly) Collect(chan<- prometheus.Metric)    {}
