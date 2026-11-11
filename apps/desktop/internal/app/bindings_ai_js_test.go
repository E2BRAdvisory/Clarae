//go:build js

package app

import (
	"strings"
	"testing"
)

// The browser has no assistant (ADR-0050): the capability is off and every AIAPI method refuses, with
// the code the frontend branches on. The package that talks to the providers is not linked into this
// build at all (TestWebAssemblyCoreDoesNotLinkTheAssistant, in internal/ai).
func TestAIAPIRefusesInTheBrowser(t *testing.T) {
	if platformCapabilities().AIAssistant {
		t.Fatal("the browser build must not offer the aiAssistant capability")
	}
	x := NewAIAPI(&App{})
	if _, err := x.Status("v"); err == nil || !strings.HasPrefix(err.Error(), "ai-disabled:") {
		t.Errorf("Status: %v", err)
	}
	if err := x.Start(struct{}{}); err == nil || !strings.HasPrefix(err.Error(), "ai-disabled:") {
		t.Errorf("Start: %v", err)
	}
	if err := x.SetKey("sk-key"); err == nil || !strings.HasPrefix(err.Error(), "ai-disabled:") {
		t.Errorf("SetKey: %v", err)
	}
	if x.Cancel("r") {
		t.Error("Cancel reported a request in the browser")
	}
}
