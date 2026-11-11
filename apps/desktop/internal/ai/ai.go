// Package ai is the writing assistant of the editor (ADR-0050): implemented, tested and inactive.
//
// The network is reached from here and nowhere else: the frontend has no provider of its own (its CSP
// has connect-src 'self', and the ready-made providers of Crepe would keep the key in the DOM). The
// package is part of the desktop core only: the WebAssembly core links none of it (internal/app
// bindings_ai_js.go), and a browser build has no way to ask a model for text.
//
// Nothing here talks to the network unless Service.Start lets it through, and Start refuses before it
// does any I/O when any of four conditions holds: the build does not enable the function
// (BuildEnabled), the Config Profile flag `ai` is off, the vault is private (end-to-end encrypted:
// its text must never leave for a third party), or no provider is configured.
package ai

import (
	"context"
	"errors"
)

// buildEnabled is the second gate of ADR-0050 (the first is the `ai` flag of the Config Profile). It
// is spelled out in the build with
//
//	-ldflags "-X memobrain/apps/desktop/internal/ai.buildEnabled=on"
//
// and is off otherwise: a released build is built without it, so a profile cannot switch the function
// on without a new release. The polarity is the opposite of updater.DisabledByBuild on purpose.
var buildEnabled = ""

// BuildEnabled reports whether this build enables the AI assistant.
func BuildEnabled() bool { return buildEnabled == "on" }

// Prompt is what the editor asks of the model: the note, the selected text (empty when there is
// none) and the instruction. It is the AIPromptContext of Crepe, which the frontend hands over.
type Prompt struct {
	Document    string
	Selection   string
	Instruction string
}

// Provider streams the answer of a model to a Prompt. It calls yield with each piece of text, in
// order, and returns when the answer is complete, when ctx is cancelled (it then returns ctx.Err())
// or when yield returns an error (which it returns unchanged).
type Provider interface {
	Stream(ctx context.Context, p Prompt, yield func(text string) error) error
}

// Why a request does not run. Each is returned (wrapped in a Refusal) before any network call.
var (
	ErrBuildOff      = errors.New("the AI assistant is not enabled in this build")
	ErrFlagOff       = errors.New("the AI assistant is switched off by the configuration profile")
	ErrPrivateVault  = errors.New("the AI assistant is not available in a private vault")
	ErrNotConfigured = errors.New("no AI provider is configured")
	ErrBusy          = errors.New("too many AI requests are running")
	ErrInvalid       = errors.New("invalid AI request")
	ErrTooLarge      = errors.New("the AI answer is too large")
)

// Reason names why the assistant is unavailable, as the frontend reads it.
type Reason string

// The reasons, in the order the gates are checked.
const (
	ReasonNone          Reason = ""
	ReasonBuild         Reason = "build"
	ReasonProfile       Reason = "profile"
	ReasonPrivateVault  Reason = "private-vault"
	ReasonNotConfigured Reason = "not-configured"
)

// reasonErr maps a reason to its error.
func reasonErr(r Reason) error {
	switch r {
	case ReasonBuild:
		return ErrBuildOff
	case ReasonProfile:
		return ErrFlagOff
	case ReasonPrivateVault:
		return ErrPrivateVault
	case ReasonNotConfigured:
		return ErrNotConfigured
	}
	return nil
}
