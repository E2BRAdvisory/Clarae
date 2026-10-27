package observability

import (
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
)

// The Grafana dashboard and the alert rules shipped in deploy/observability may only use
// metrics this package registers: a renamed or removed metric must fail here, not silently
// leave an empty panel.
func TestDeployAssetsUseExistingMetrics(t *testing.T) {
	m := New()
	collectors := []prometheus.Collector{m.requests, m.duration, m.inflight, syncCommits, syncOps, streams, jobRuns, jobDuration, jobLastSuccess, poolCollector{}}
	known := map[string]bool{}
	for _, c := range collectors {
		ch := make(chan *prometheus.Desc, 16)
		go func() { c.Describe(ch); close(ch) }()
		for d := range ch {
			// Desc.String(): Desc{fqName: "memobrain_x", help: ...}
			if m := regexp.MustCompile(`fqName: "([^"]+)"`).FindStringSubmatch(d.String()); m != nil {
				known[m[1]] = true
			}
		}
	}
	if len(known) < 10 {
		t.Fatalf("collected only %d metric names: %v", len(known), known)
	}
	token := regexp.MustCompile(`\bmemobrain_[a-z0-9_]+`)
	for _, f := range []string{
		"../../../../deploy/observability/grafana/memobrain-overview.json",
		"../../../../deploy/observability/prometheus/alerts.yaml",
	} {
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for _, name := range token.FindAllString(string(raw), -1) {
			base := name
			for _, suf := range []string{"_bucket", "_sum", "_count"} {
				if strings.HasSuffix(name, suf) && known[strings.TrimSuffix(name, suf)] {
					base = strings.TrimSuffix(name, suf)
				}
			}
			if !known[base] && name != "memobrain_overview" {
				t.Errorf("%s uses unknown metric %q", f, name)
			}
		}
	}
}
