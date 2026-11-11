//go:build js

package app

// The browser build has no AI assistant (ADR-0050): the Content-Security-Policy of the page allows no
// third party, and a provider reached from the page would put the key in it. AIAPI keeps its methods,
// so the bindings are the same on both hosts, but each one refuses; internal/ai (providers, keychain)
// stays out of the WebAssembly core, which has a size budget (ADR-0030). The workbench hides the
// function there (capability "aiAssistant").

import "errors"

// errNoAI answers every AIAPI call in the browser.
var errNoAI = errors.New("ai-disabled: the AI assistant is not available in the browser")

// aiState holds nothing in the browser.
type aiState struct{}

// shutdownAI has nothing to stop in the browser.
func (a *App) shutdownAI() {}

// AIAPI exposes the writing assistant: not available in the browser.
type AIAPI struct{ app *App }

// NewAIAPI binds the API.
func NewAIAPI(a *App) *AIAPI { return &AIAPI{app: a} }

// Status is not available in the browser.
func (x *AIAPI) Status(string) (struct{}, error) { return struct{}{}, errNoAI }

// Start is not available in the browser.
func (x *AIAPI) Start(struct{}) error { return errNoAI }

// Cancel is not available in the browser.
func (x *AIAPI) Cancel(string) bool { return false }

// SetKey is not available in the browser.
func (x *AIAPI) SetKey(string) error { return errNoAI }
