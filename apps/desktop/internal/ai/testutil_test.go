package ai

import (
	"context"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// recorder is the RoundTripper of the "zero requests" tests: it counts every request the clients of
// the package make and forwards it to the real transport.
type recorder struct {
	n    atomic.Int64
	mu   sync.Mutex
	urls []string
}

func (r *recorder) RoundTrip(req *http.Request) (*http.Response, error) {
	r.n.Add(1)
	r.mu.Lock()
	r.urls = append(r.urls, req.URL.String())
	r.mu.Unlock()
	return http.DefaultTransport.RoundTrip(req)
}

func (r *recorder) client() *http.Client { return &http.Client{Transport: r} }
func (r *recorder) count() int           { return int(r.n.Load()) }

// sink collects what the service delivers.
type sink struct {
	mu     sync.Mutex
	chunks []Chunk
	done   chan Done
}

func newSink() *sink { return &sink{done: make(chan Done, 8)} }

func (s *sink) onChunk(c Chunk) {
	s.mu.Lock()
	s.chunks = append(s.chunks, c)
	s.mu.Unlock()
}
func (s *sink) onDone(d Done) { s.done <- d }

func (s *sink) text() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := ""
	for _, c := range s.chunks {
		out += c.Text
	}
	return out
}

func (s *sink) wait(t *testing.T) Done {
	t.Helper()
	select {
	case d := <-s.done:
		return d
	case <-time.After(10 * time.Second):
		t.Fatal("the request never ended")
		return Done{}
	}
}

// gates are the four conditions of the service, all open by default.
type gates struct {
	build, flag, private, configured bool
	privateErr                       error
	cfg                              Config
	key                              string
}

func openGates() gates {
	return gates{build: true, flag: true, configured: true, key: "sk-test-key",
		cfg: Config{Provider: KindOpenAI, Model: "m", BaseURL: "http://127.0.0.1:1"}}
}

// service builds a Service over g, delivering to s; opts adjusts the options.
func (g gates) service(s *sink, opts ...func(*Options)) *Service {
	secrets := &MemorySecrets{}
	if g.key != "" {
		_ = secrets.Set(g.key)
	}
	o := Options{
		Flag:    func() bool { return g.flag },
		Private: func(context.Context, string) (bool, error) { return g.private, g.privateErr },
		Config: func() (Config, error) {
			if !g.configured {
				return Config{}, ErrNotConfigured
			}
			return g.cfg.Normalize()
		},
		Secrets: secrets,
		OnChunk: s.onChunk,
		OnDone:  s.onDone,
		Build:   func() bool { return g.build },
	}
	for _, f := range opts {
		f(&o)
	}
	return NewService(o)
}

func startReq(id string) StartRequest {
	return StartRequest{VaultID: "v1", RequestID: id, Prompt: Prompt{Document: "# T\n\nhello\n", Selection: "hello", Instruction: "shout"}}
}
