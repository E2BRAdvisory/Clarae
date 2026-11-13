package observability

import (
	"os"
	"os/exec"
	"regexp"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
)

// fqNames returns the full metric names a collector describes.
func fqNames(c prometheus.Collector) []string {
	ch := make(chan *prometheus.Desc, 16)
	go func() { c.Describe(ch); close(ch) }()
	var out []string
	for d := range ch {
		if m := regexp.MustCompile(`fqName: "([^"]+)"`).FindStringSubmatch(d.String()); m != nil {
			out = append(out, m[1])
		}
	}
	return out
}

// TestNamespaceHelper is not a test: the one below runs it in a child process, whose package
// initialisation sees the environment it was given (the namespace is read once, at init).
func TestNamespaceHelper(t *testing.T) {
	if os.Getenv("OBSERVABILITY_NAMESPACE_HELPER") == "" {
		t.Skip("helper of TestMetricNamesFollowTheEnvironment")
	}
	m := newMetrics()
	names := append(fqNames(m.requests), fqNames(syncCommits)...)
	names = append(names, fqNames(jobLastSuccess)...)
	t.Logf("NAMES %s", strings.Join(names, " "))
}

func TestMetricNamesFollowTheEnvironment(t *testing.T) {
	for _, tc := range []struct {
		name   string
		env    []string
		prefix string
	}{
		{"new installation", []string{"METRICS_NAMESPACE=", "OIDC_ISSUER=https://auth.example.com/realms/clarae"}, "clarae_"},
		{"no issuer", []string{"METRICS_NAMESPACE=", "OIDC_ISSUER="}, "clarae_"},
		// An installation made for 1.x keeps the names its dashboards and alerts query.
		{"1.x realm", []string{"METRICS_NAMESPACE=", "OIDC_ISSUER=https://auth.example.com/realms/memobrain"}, "memobrain_"},
		{"override on a 1.x realm", []string{"METRICS_NAMESPACE=clarae", "OIDC_ISSUER=https://auth.example.com/realms/memobrain"}, "clarae_"},
		{"override with another name", []string{"METRICS_NAMESPACE=notes_cloud", "OIDC_ISSUER=https://auth.example.com/realms/clarae"}, "notes_cloud_"},
		// An invalid value must not panic the registration: Load refuses it, the collectors use the family.
		{"invalid override", []string{"METRICS_NAMESPACE=Not Valid", "OIDC_ISSUER=https://auth.example.com/realms/clarae"}, "clarae_"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cmd := exec.Command(os.Args[0], "-test.run=^TestNamespaceHelper$", "-test.v") //nolint:gosec // re-executes this test binary
			cmd.Env = append(os.Environ(), append([]string{"OBSERVABILITY_NAMESPACE_HELPER=1"}, tc.env...)...)
			out, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("child: %v\n%s", err, out)
			}
			m := regexp.MustCompile(`NAMES (.*)`).FindStringSubmatch(string(out))
			if m == nil {
				t.Fatalf("no metric names in the output:\n%s", out)
			}
			names := strings.Fields(m[1])
			if len(names) < 3 {
				t.Fatalf("names %v", names)
			}
			for _, n := range names {
				if !strings.HasPrefix(n, tc.prefix) {
					t.Errorf("metric %q does not start with %q", n, tc.prefix)
				}
			}
		})
	}
}
