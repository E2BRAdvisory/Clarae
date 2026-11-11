package ai

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
)

// The answer of the fake provider reaches the sink in order, and the prompt reaches the provider.
func TestFakeProvider(t *testing.T) {
	fake := &Fake{Chunks: []string{"a", "", "b", "c"}}
	s := newSink()
	svc := openGates().service(s, func(o *Options) { o.Provider = func(Config, string) Provider { return fake } })
	defer svc.Close()
	if err := svc.Start(context.Background(), startReq("r1")); err != nil {
		t.Fatal(err)
	}
	if d := s.wait(t); !d.OK {
		t.Fatalf("done = %+v", d)
	}
	if s.text() != "abc" || len(s.chunks) != 3 {
		t.Fatalf("chunks = %+v", s.chunks)
	}
	if p := fake.Prompts(); len(p) != 1 || p[0].Selection != "hello" || p[0].Instruction != "shout" {
		t.Fatalf("prompts = %+v", p)
	}
}

func TestFakeProviderError(t *testing.T) {
	s := newSink()
	svc := openGates().service(s, func(o *Options) {
		o.Provider = func(Config, string) Provider { return &Fake{Chunks: []string{"a"}, Err: errors.New("boom")} }
	})
	defer svc.Close()
	if err := svc.Start(context.Background(), startReq("r1")); err != nil {
		t.Fatal(err)
	}
	d := s.wait(t)
	if d.OK || d.Cancelled || d.Error != "boom" || s.text() != "a" {
		t.Fatalf("done = %+v, text %q", d, s.text())
	}
}

func TestCloseCancelsEverything(t *testing.T) {
	hold := make(chan struct{})
	defer close(hold)
	s := newSink()
	svc := openGates().service(s, func(o *Options) {
		o.Provider = func(Config, string) Provider { return &Fake{Chunks: []string{"a", "b"}, Hold: hold} }
	})
	for _, id := range []string{"r1", "r2"} {
		if err := svc.Start(context.Background(), startReq(id)); err != nil {
			t.Fatal(err)
		}
	}
	svc.Close()
	for range 2 {
		if d := s.wait(t); !d.Cancelled {
			t.Fatalf("done = %+v", d)
		}
	}
}

func TestStartValidatesTheRequest(t *testing.T) {
	hold := make(chan struct{})
	defer close(hold)
	s := newSink()
	svc := openGates().service(s, func(o *Options) {
		o.Provider = func(Config, string) Provider { return &Fake{Chunks: []string{"a", "b"}, Hold: hold} }
	})
	defer svc.Close()
	bad := func(mut func(*StartRequest)) error {
		r := startReq("ok")
		mut(&r)
		return svc.Start(context.Background(), r)
	}
	for name, mut := range map[string]func(*StartRequest){
		"empty id":     func(r *StartRequest) { r.RequestID = "" },
		"id with a /":  func(r *StartRequest) { r.RequestID = "a/b" },
		"id too long":  func(r *StartRequest) { r.RequestID = strings.Repeat("a", 65) },
		"no direction": func(r *StartRequest) { r.Prompt.Instruction = "  \n" },
	} {
		if err := bad(mut); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: %v, want ErrInvalid", name, err)
		}
	}
	if err := bad(func(r *StartRequest) { r.Prompt.Document = strings.Repeat("x", MaxPromptBytes) }); !errors.Is(err, ErrTooLarge) {
		t.Errorf("a document over the limit: %v, want ErrTooLarge", err)
	}
	// Duplicate ids and the limit of concurrent requests.
	if err := svc.Start(context.Background(), startReq("r1")); err != nil {
		t.Fatal(err)
	}
	if err := svc.Start(context.Background(), startReq("r1")); !errors.Is(err, ErrInvalid) {
		t.Errorf("a running id: %v, want ErrInvalid", err)
	}
	if err := svc.Start(context.Background(), startReq("r2")); err != nil {
		t.Fatal(err)
	}
	if err := svc.Start(context.Background(), startReq("r3")); !errors.Is(err, ErrBusy) {
		t.Errorf("a third request: %v, want ErrBusy", err)
	}
}

// A provider that answers more than the limit ends with an error and the chunks stop there.
func TestAnswerLimit(t *testing.T) {
	big := strings.Repeat("x", 1<<19)
	s := newSink()
	svc := openGates().service(s, func(o *Options) {
		o.Provider = func(Config, string) Provider { return &Fake{Chunks: []string{big, big, big}} }
	})
	defer svc.Close()
	if err := svc.Start(context.Background(), startReq("r1")); err != nil {
		t.Fatal(err)
	}
	d := s.wait(t)
	if d.OK || !strings.Contains(d.Error, "too large") || len(s.text()) != 2*len(big) {
		t.Fatalf("done = %+v, delivered %d bytes", d, len(s.text()))
	}
}

func TestSetKey(t *testing.T) {
	g := openGates()
	g.key = ""
	secrets := &MemorySecrets{}
	svc := g.service(newSink(), func(o *Options) { o.Secrets = secrets })
	if err := svc.SetKey("sk-abc123"); err != nil {
		t.Fatal(err)
	}
	if k, _ := secrets.Get(); k != "sk-abc123" {
		t.Fatalf("stored %q", k)
	}
	for _, bad := range []string{"has space", "line\nbreak", "tab\t", "accentà", strings.Repeat("k", 4097)} {
		if err := svc.SetKey(bad); !errors.Is(err, ErrInvalid) {
			t.Errorf("SetKey(%q) = %v, want ErrInvalid", bad, err)
		}
	}
	if k, _ := secrets.Get(); k != "sk-abc123" {
		t.Fatalf("a refused key changed the stored one: %q", k)
	}
	if err := svc.SetKey(""); err != nil {
		t.Fatal(err)
	}
	if k, _ := secrets.Get(); k != "" {
		t.Fatalf("the key was not forgotten: %q", k)
	}
	// With the build gate closed the key is not written either.
	g.build = false
	off := g.service(newSink(), func(o *Options) { o.Secrets = secrets })
	if err := off.SetKey("sk-abc123"); !errors.Is(err, ErrBuildOff) {
		t.Fatalf("SetKey with the build off = %v", err)
	}
	if k, _ := secrets.Get(); k != "" {
		t.Fatalf("a key was stored by a build that has the function off: %q", k)
	}
}

// The default build constant is off: a build that does not name it does not offer the assistant.
func TestBuildConstantIsOffByDefault(t *testing.T) {
	if BuildEnabled() {
		t.Fatal("buildEnabled must be empty in the source: only -ldflags turns it on")
	}
	svc := NewService(Options{Flag: func() bool { return true }, Private: func(context.Context, string) (bool, error) { return false, nil },
		Config: func() (Config, error) { return Config{}, ErrNotConfigured }, Secrets: &MemorySecrets{}})
	if st := svc.Status(context.Background(), "v"); st.Build || st.Reason != ReasonBuild {
		t.Fatalf("Status = %+v", st)
	}
}

// A request does not outlive the flag that allowed it: the profile turned off while it runs ends it.
func TestFlagTurnedOffMidRequestEndsIt(t *testing.T) {
	var mu sync.Mutex
	off := false
	s := newSink()
	svc := openGates().service(s, func(o *Options) {
		o.Flag = func() bool { mu.Lock(); defer mu.Unlock(); return !off }
		o.Provider = func(Config, string) Provider {
			return providerFunc(func(_ context.Context, _ Prompt, yield func(string) error) error {
				if err := yield("a"); err != nil {
					return err
				}
				mu.Lock()
				off = true // the administrator's profile arrives
				mu.Unlock()
				return yield("b")
			})
		}
	})
	defer svc.Close()
	if err := svc.Start(context.Background(), startReq("r1")); err != nil {
		t.Fatal(err)
	}
	d := s.wait(t)
	if d.OK || d.Cancelled || d.Error != ErrFlagOff.Error() {
		t.Fatalf("done = %+v", d)
	}
	if s.text() != "a" {
		t.Fatalf("delivered %q: nothing may arrive after the flag went off", s.text())
	}
}

type providerFunc func(ctx context.Context, p Prompt, yield func(string) error) error

func (f providerFunc) Stream(ctx context.Context, p Prompt, yield func(string) error) error {
	return f(ctx, p, yield)
}

func TestStartAfterCloseIsRefused(t *testing.T) {
	svc := openGates().service(newSink(), func(o *Options) {
		o.Provider = func(Config, string) Provider { return &Fake{Chunks: []string{"a"}} }
	})
	svc.Close()
	if err := svc.Start(context.Background(), startReq("r1")); !errors.Is(err, ErrInvalid) {
		t.Fatalf("Start after Close = %v", err)
	}
}

// No chunk is delivered after Cancel has returned, even from a provider that does not look at its
// context (a transport that was already reading the next event).
func TestNoChunkAfterCancel(t *testing.T) {
	first, release := make(chan struct{}), make(chan struct{})
	s := newSink()
	svc := openGates().service(s, func(o *Options) {
		o.Provider = func(Config, string) Provider {
			return providerFunc(func(_ context.Context, _ Prompt, yield func(string) error) error {
				if err := yield("a"); err != nil {
					return err
				}
				close(first)
				<-release // the cancellation happens here
				_ = yield("b")
				return yield("c")
			})
		}
	})
	defer svc.Close()
	if err := svc.Start(context.Background(), startReq("r1")); err != nil {
		t.Fatal(err)
	}
	<-first
	if !svc.Cancel("r1") {
		t.Fatal("Cancel found no request")
	}
	close(release)
	if d := s.wait(t); !d.Cancelled || d.OK {
		t.Fatalf("done = %+v", d)
	}
	if s.text() != "a" {
		t.Fatalf("delivered %q: nothing may follow Cancel", s.text())
	}
}
