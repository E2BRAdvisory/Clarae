//go:build !js

package app

import (
	"testing"

	"clarae/apps/desktop/internal/presence"
)

// A vault that is not linked to the cloud (here a local one) is not shared: no room, no connection.
// Signed out, the answer is offline, and a position for a file that is not watched is ignored.
func TestPresenceAPIWithoutCloud(t *testing.T) {
	a, info, _ := newTestApp(t)
	api := NewPresenceAPI(a)
	w, err := api.Watch(info.ID, "a.md")
	if err != nil || w.Watching || w.Reason != presence.ReasonOffline {
		t.Errorf("Watch signed out = %+v, %v", w, err)
	}
	if err := api.Move(info.ID, "a.md", presence.Pos{Kind: presence.PosText, Line: 1}); err != nil {
		t.Errorf("Move of a file that is not watched: %v", err)
	}
	if err := api.Move(info.ID, "a.md", presence.Pos{Kind: "bogus"}); err == nil {
		t.Error("Move accepted an unknown kind")
	}
	if err := api.Unwatch(info.ID, "a.md"); err != nil {
		t.Errorf("Unwatch: %v", err)
	}
	if !platformCapabilities().Has(CapPresence) {
		t.Error("the presence capability is off on this host")
	}
}
