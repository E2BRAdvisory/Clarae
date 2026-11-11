package ai

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog"
)

// The limits of a request: what goes to the model, what comes back, how long it may run, how many
// run together.
const (
	MaxPromptBytes = 1 << 20
	MaxAnswerBytes = 1 << 20
	MaxDuration    = 5 * time.Minute
	maxRunning     = 2
)

var requestIDRE = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// Chunk is a piece of the answer. Seq counts from 0 within the request.
type Chunk struct {
	RequestID string
	Seq       int
	Text      string
}

// Done ends a request: exactly one per request that Start accepted, after its last Chunk.
type Done struct {
	RequestID string
	// OK: the answer is complete.
	OK bool
	// Cancelled: the user (or the shutdown of the app) stopped it. OK is false, and Error empty.
	Cancelled bool
	Error     string
}

// Status is what the frontend may know before it asks for anything: which gate is closed, if any.
type Status struct {
	// Available: Start would run (every gate is open).
	Available bool
	Reason    Reason
	// Build, Flag, Private and Configured are the four conditions; Private is true when the vault
	// is private or when that could not be told.
	Build      bool
	Flag       bool
	Private    bool
	Configured bool
	// Provider and Model name the configured model (never the key).
	Provider string
	Model    string
}

// StartRequest asks for an answer. The caller chooses RequestID (so it can listen before it asks)
// and addresses the chunks with it.
type StartRequest struct {
	VaultID   string
	RequestID string
	Prompt    Prompt
}

// Options connect the service to the application. Every function is required but the ones marked.
type Options struct {
	// Flag reports the `ai` flag of the Config Profile in force.
	Flag func() bool
	// Private reports whether the vault is end-to-end encrypted. An error counts as "private": a
	// vault the app cannot classify is not sent to a third party.
	Private func(ctx context.Context, vaultID string) (bool, error)
	// Config returns the provider settings (ErrNotConfigured, possibly wrapped, when there are none).
	Config func() (Config, error)
	// Secrets keeps the key of the provider.
	Secrets Secrets
	// OnChunk and OnDone deliver the answer to the frontend (one event each).
	OnChunk func(Chunk)
	OnDone  func(Done)
	// Context is the lifetime of the requests: they end when it does (optional: the process).
	Context func() context.Context
	// Build overrides BuildEnabled (optional, for tests).
	Build func() bool
	// Client is the HTTP client of the providers (optional: NewHTTPClient). Tests pass one whose
	// transport records every request.
	Client *http.Client
	// Provider replaces the HTTP providers (optional, for tests): it is given the settings and the key.
	Provider func(cfg Config, key string) Provider
	Logger   zerolog.Logger
}

// Service runs the requests. It holds no secret between calls: the key is read from Secrets when a
// request starts.
type Service struct {
	o Options

	mu      sync.Mutex
	running map[string]*request
	closed  bool // Close was called: no request starts any more
	wg      sync.WaitGroup
}

type request struct {
	cancel context.CancelFunc
	// mu orders Cancel against the delivery of chunks: once Cancel has returned no chunk follows.
	mu        sync.Mutex
	cancelled bool
}

// NewService builds the service.
func NewService(o Options) *Service {
	if o.Build == nil {
		o.Build = BuildEnabled
	}
	return &Service{o: o, running: map[string]*request{}}
}

// gate returns the first closed gate, with the settings and the key when all are open. It does no
// network I/O.
func (s *Service) gate(ctx context.Context, vaultID string) (Status, Config, string) {
	st := Status{Build: s.o.Build()}
	if !st.Build {
		st.Reason = ReasonBuild
		return st, Config{}, ""
	}
	st.Flag = s.o.Flag()
	if !st.Flag {
		st.Reason = ReasonProfile
		return st, Config{}, ""
	}
	private, err := s.o.Private(ctx, vaultID)
	st.Private = private || err != nil
	if st.Private {
		st.Reason = ReasonPrivateVault
		return st, Config{}, ""
	}
	cfg, key, ok := s.provider()
	if !ok {
		st.Reason = ReasonNotConfigured
		return st, Config{}, ""
	}
	st.Configured, st.Provider, st.Model = true, cfg.Provider, cfg.Model
	st.Available = true
	return st, cfg, key
}

// provider reads the settings and the key; ok is false unless both are there (a local server needs no key).
func (s *Service) provider() (Config, string, bool) {
	cfg, err := s.o.Config()
	if err != nil {
		return Config{}, "", false
	}
	key, err := s.o.Secrets.Get()
	if err != nil || (key == "" && cfg.NeedsKey()) {
		return Config{}, "", false
	}
	return cfg, key, true
}

// Status says whether the assistant is available for the vault, and if not, which gate is closed.
func (s *Service) Status(ctx context.Context, vaultID string) Status {
	st, _, _ := s.gate(ctx, vaultID)
	return st
}

// Start checks the gates, and only then starts the request in the background; the answer comes
// through OnChunk and OnDone. A refusal is a *Refusal and happened before any I/O.
func (s *Service) Start(ctx context.Context, r StartRequest) error {
	st, cfg, key := s.gate(ctx, r.VaultID)
	if !st.Available {
		return &Refusal{Reason: st.Reason}
	}
	if err := validate(r); err != nil {
		return err
	}
	prov := s.providerFor(cfg, key)

	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return fmt.Errorf("%w: the assistant is closed", ErrInvalid)
	}
	if _, dup := s.running[r.RequestID]; dup {
		s.mu.Unlock()
		return fmt.Errorf("%w: request %q is already running", ErrInvalid, r.RequestID)
	}
	if len(s.running) >= maxRunning {
		s.mu.Unlock()
		return ErrBusy
	}
	rctx, cancel := context.WithTimeout(s.lifetime(), MaxDuration)
	req := &request{cancel: cancel}
	s.running[r.RequestID] = req
	s.wg.Add(1)
	s.mu.Unlock()

	go s.run(rctx, req, r, prov)
	return nil
}

func (s *Service) lifetime() context.Context {
	if s.o.Context != nil {
		if c := s.o.Context(); c != nil {
			return c
		}
	}
	return context.Background()
}

func validate(r StartRequest) error {
	if !requestIDRE.MatchString(r.RequestID) {
		return fmt.Errorf("%w: the request id must be 1-64 letters, digits, - or _", ErrInvalid)
	}
	if strings.TrimSpace(r.Prompt.Instruction) == "" {
		return fmt.Errorf("%w: the instruction is empty", ErrInvalid)
	}
	if n := len(r.Prompt.Document) + len(r.Prompt.Selection) + len(r.Prompt.Instruction); n > MaxPromptBytes {
		return fmt.Errorf("%w: the text is %d bytes, the limit is %d", ErrTooLarge, n, MaxPromptBytes)
	}
	return nil
}

func (s *Service) providerFor(cfg Config, key string) Provider {
	if s.o.Provider != nil {
		return s.o.Provider(cfg, key)
	}
	switch cfg.Provider {
	case KindAnthropic:
		return Anthropic{BaseURL: cfg.BaseURL, Model: cfg.Model, APIKey: key, MaxTokens: cfg.MaxTokens, Client: s.o.Client}
	default:
		return OpenAI{BaseURL: cfg.BaseURL, Model: cfg.Model, APIKey: key, Client: s.o.Client}
	}
}

func (s *Service) run(ctx context.Context, req *request, r StartRequest, prov Provider) {
	defer s.wg.Done()
	defer req.cancel()
	seq, total := 0, 0
	err := prov.Stream(ctx, r.Prompt, func(text string) error {
		if text == "" {
			return nil
		}
		total += len(text)
		if total > MaxAnswerBytes {
			return fmt.Errorf("%w: more than %d bytes", ErrTooLarge, MaxAnswerBytes)
		}
		req.mu.Lock()
		defer req.mu.Unlock()
		if req.cancelled || ctx.Err() != nil {
			return context.Canceled
		}
		// The gates were open when the request started; the profile may change while it runs (the
		// vault kind cannot: D-02). A request does not outlive the flag that allowed it.
		if !s.o.Flag() {
			return ErrFlagOff
		}
		s.o.OnChunk(Chunk{RequestID: r.RequestID, Seq: seq, Text: text})
		seq++
		return nil
	})

	req.mu.Lock()
	cancelled := req.cancelled
	req.mu.Unlock()
	done := Done{RequestID: r.RequestID, OK: err == nil && !cancelled}
	switch {
	case cancelled:
		done.Cancelled, done.OK = true, false
	case errors.Is(err, context.DeadlineExceeded):
		done.Error = "the provider took too long to answer"
	case err != nil:
		done.Error = err.Error()
		s.o.Logger.Warn().Str("request", r.RequestID).Msg("ai request failed")
	}
	s.mu.Lock()
	delete(s.running, r.RequestID)
	s.mu.Unlock()
	s.o.OnDone(done)
}

// Cancel stops a request; it reports whether one was running. No chunk is delivered after it returns;
// the Done follows with Cancelled set.
func (s *Service) Cancel(requestID string) bool {
	s.mu.Lock()
	req := s.running[requestID]
	s.mu.Unlock()
	if req == nil {
		return false
	}
	req.stop()
	return true
}

func (r *request) stop() {
	r.mu.Lock()
	r.cancelled = true
	r.mu.Unlock()
	r.cancel()
}

// Close cancels every request and waits for the Done of each; no request starts afterwards.
func (s *Service) Close() {
	s.mu.Lock()
	s.closed = true
	for _, r := range s.running {
		r.stop()
	}
	s.mu.Unlock()
	s.wg.Wait()
}

// SetKey stores the key of the provider (an empty key forgets it). Only the build gate applies: the
// key is not text of a vault and nothing is sent anywhere. The key is never read back by the app's
// bindings.
func (s *Service) SetKey(key string) error {
	if !s.o.Build() {
		return &Refusal{Reason: ReasonBuild}
	}
	if key == "" {
		return s.o.Secrets.Delete()
	}
	if err := ValidateKey(key); err != nil {
		return err
	}
	return s.o.Secrets.Set(key)
}

// Refusal is the error of a Start that a gate stopped, before any network call.
type Refusal struct{ Reason Reason }

func (r *Refusal) Error() string { return reasonErr(r.Reason).Error() }

// Unwrap lets errors.Is find ErrBuildOff, ErrFlagOff, ErrPrivateVault or ErrNotConfigured.
func (r *Refusal) Unwrap() error { return reasonErr(r.Reason) }
