//go:build !js

package app

// The AI writing assistant of the editor (ADR-0050): implemented, tested and inactive. It is in the
// desktop core only: the browser build has no way to ask a model (bindings_ai_js.go), and the
// WebAssembly core links none of internal/ai. A request runs only if four gates are open (the build
// constant, the Config Profile flag `ai`, a vault that is not private, a configured provider); the
// frontend shows nothing and sends nothing otherwise.

import (
	"context"
	"errors"
	"sync"

	"clarae/apps/desktop/internal/ai"
	"clarae/apps/desktop/internal/events"
	flags "clarae/shared/features"
)

// Codes of the errors of AIAPI (see the binding errors of errors.go).
const (
	// ErrCodeAIDisabled: the function is off, by the build or by the configuration profile.
	ErrCodeAIDisabled = "ai-disabled"
	// ErrCodeAIPrivateVault: the vault is private (end-to-end encrypted): its text never goes to a provider.
	ErrCodeAIPrivateVault = "ai-private-vault"
	// ErrCodeAINotConfigured: no provider (or no key for it) is configured.
	ErrCodeAINotConfigured = "ai-not-configured"
	// ErrCodeAIBusy: too many requests are running.
	ErrCodeAIBusy = "ai-busy"
	// ErrCodeAIInvalid: the request is malformed or too large.
	ErrCodeAIInvalid = "ai-invalid"
)

// The events of a request: the answer comes as chunks, then one `ai:done`.
var (
	EventAIChunk = events.New[AIChunkPayload]("ai:chunk",
		"Desktop: a piece of the answer of the AI assistant to a request (AIAPI.Start), in order of seq.")
	EventAIDone = events.New[AIDonePayload]("ai:done",
		"Desktop: a request of the AI assistant ended (complete, cancelled or failed); no chunk follows.")
)

// AIChunkPayload accompanies EventAIChunk.
type AIChunkPayload struct {
	RequestID string `json:"requestId"`
	Seq       int    `json:"seq"`
	Text      string `json:"text"`
}

// AIDonePayload accompanies EventAIDone.
type AIDonePayload struct {
	RequestID string `json:"requestId"`
	// OK: the answer is complete.
	OK bool `json:"ok"`
	// Cancelled: AIAPI.Cancel (or the closing of the app) stopped it.
	Cancelled bool   `json:"cancelled"`
	Error     string `json:"error"`
}

// AIStatus tells the frontend whether the assistant is available for a vault, and why not. It never
// carries the key or any setting that could identify the account.
type AIStatus struct {
	// Available: AIAPI.Start would run.
	Available bool `json:"available"`
	// Reason is the first closed gate: "build", "profile", "private-vault" or "not-configured"; empty when available.
	Reason string `json:"reason"`
	// The four conditions. Private is also true when the core could not tell what the vault is.
	Build      bool `json:"build"`
	Flag       bool `json:"flag"`
	Private    bool `json:"private"`
	Configured bool `json:"configured"`
	// Provider and Model name the configured model.
	Provider string `json:"provider"`
	Model    string `json:"model"`
}

// AIStartRequest is a request for the model. RequestID is chosen by the caller, which listens for
// the events before it asks: the chunks and the end carry it.
type AIStartRequest struct {
	VaultID     string `json:"vaultId"`
	RequestID   string `json:"requestId"`
	Document    string `json:"document"`
	Selection   string `json:"selection"`
	Instruction string `json:"instruction"`
}

// aiState is the service of the app, built on first use.
type aiState struct {
	mu  sync.Mutex
	svc *ai.Service
	// tune lets tests change the options before the service is built.
	tune func(*ai.Options)
}

// aiService builds the service (it needs the data directory and the configuration only).
func (a *App) aiService() *ai.Service {
	a.ai.mu.Lock()
	defer a.ai.mu.Unlock()
	if a.ai.svc != nil {
		return a.ai.svc
	}
	o := ai.Options{
		// Read at each call: Startup replaces a.config, and a refresh changes the profile.
		Flag: func() bool { return flags.Enabled(a.config.Current().Config, flags.Ai) },
		Private: func(ctx context.Context, vaultID string) (bool, error) {
			// InfoStrict, not Info: Info hides a failure to read the meta table, and a vault whose cloud
			// vault cannot be read looks like one that is not linked, which is open to the assistant.
			info, err := a.sync.InfoStrict(ctx, vaultID)
			// Fail closed: a linked vault is open to the assistant only when it is known to be shared.
			// saveLink writes its keys one by one, so a vault may be linked with an empty kind: that is
			// not a proof that it is not end-to-end encrypted.
			return err != nil || (info.Linked && info.Kind != "shared"), err
		},
		Config:  func() (ai.Config, error) { return ai.LoadConfig(a.opts.DataDir) },
		Secrets: ai.DefaultSecrets(),
		OnChunk: func(c ai.Chunk) {
			EventAIChunk.Send(a.emit, AIChunkPayload{RequestID: c.RequestID, Seq: c.Seq, Text: c.Text})
		},
		OnDone: func(d ai.Done) {
			EventAIDone.Send(a.emit, AIDonePayload{RequestID: d.RequestID, OK: d.OK, Cancelled: d.Cancelled, Error: d.Error})
		},
		Context: a.appContext,
		Logger:  a.logger.With().Str("module", "ai").Logger(),
	}
	if a.ai.tune != nil {
		a.ai.tune(&o)
	}
	a.ai.svc = ai.NewService(o)
	return a.ai.svc
}

// shutdownAI stops the requests that are running (the app is closing).
func (a *App) shutdownAI() {
	a.ai.mu.Lock()
	svc := a.ai.svc
	a.ai.mu.Unlock()
	if svc != nil {
		svc.Close()
	}
}

// aiError gives an error of internal/ai the code the frontend branches on.
func aiError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, ai.ErrBuildOff), errors.Is(err, ai.ErrFlagOff):
		return coded(ErrCodeAIDisabled, err.Error(), err)
	case errors.Is(err, ai.ErrPrivateVault):
		return coded(ErrCodeAIPrivateVault, err.Error(), err)
	case errors.Is(err, ai.ErrNotConfigured):
		return coded(ErrCodeAINotConfigured, err.Error(), err)
	case errors.Is(err, ai.ErrBusy):
		return coded(ErrCodeAIBusy, err.Error(), err)
	case errors.Is(err, ai.ErrInvalid), errors.Is(err, ai.ErrTooLarge):
		return coded(ErrCodeAIInvalid, err.Error(), err)
	}
	return bindingError(err)
}

// AIAPI exposes the writing assistant (ADR-0050). Nothing calls it while the function is inactive.
type AIAPI struct{ app *App }

// NewAIAPI binds the API.
func NewAIAPI(a *App) *AIAPI { return &AIAPI{app: a} }

// Status reports whether the assistant is available for the vault, and which gate is closed if not.
// It makes no network request.
func (x *AIAPI) Status(vaultID string) (AIStatus, error) {
	st := x.app.aiService().Status(x.app.ctxOrBackground(), vaultID)
	return AIStatus{
		Available: st.Available, Reason: string(st.Reason),
		Build: st.Build, Flag: st.Flag, Private: st.Private, Configured: st.Configured,
		Provider: st.Provider, Model: st.Model,
	}, nil
}

// Start asks the model and returns at once; the answer arrives as `ai:chunk` events and ends with
// `ai:done`. The core refuses, before any network call, when the build or the configuration profile
// has the function off, when the vault is private, or when no provider is configured.
func (x *AIAPI) Start(req AIStartRequest) error {
	return aiError(x.app.aiService().Start(x.app.ctxOrBackground(), ai.StartRequest{
		VaultID:   req.VaultID,
		RequestID: req.RequestID,
		Prompt:    ai.Prompt{Document: req.Document, Selection: req.Selection, Instruction: req.Instruction},
	}))
}

// Cancel stops a request; it reports whether one was running.
func (x *AIAPI) Cancel(requestID string) bool {
	return x.app.aiService().Cancel(requestID)
}

// SetKey stores the key of the provider in the OS keychain (an empty key forgets it). It is write
// only: no binding returns the key. It is refused by a build that has the function off.
func (x *AIAPI) SetKey(key string) error {
	return aiError(x.app.aiService().SetKey(key))
}
