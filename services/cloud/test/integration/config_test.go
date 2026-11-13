//go:build integration

package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"clarae/services/cloud/internal/configprofiles"
	"clarae/services/cloud/internal/notify"
)

type effective struct {
	Version    int            `json:"version"`
	Config     map[string]any `json:"config"`
	LockedKeys []string       `json:"locked_keys"`
}

func (c *client) effective() (effective, string) {
	c.e.t.Helper()
	resp := c.json(http.MethodGet, "/config/effective", nil)
	expect(c.e.t, resp, http.StatusOK)
	etag := resp.Header.Get("ETag")
	return decode[effective](c.e.t, resp), etag
}

func sub(m map[string]any, key string) map[string]any {
	v, _ := m[key].(map[string]any)
	return v
}

func TestConfigResolutionOrderAndLockedKeys(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	admin, bob, carol := e.user("admin"), e.user("bob"), e.user("carol")
	team := e.group("team", admin, bob)
	elite := e.group("elite", bob)

	// Product defaults for a user without any profile.
	base, _ := carol.effective()
	if sub(base.Config, "sync")["interval_seconds"] != float64(30) || len(base.LockedKeys) != 0 {
		t.Fatalf("defaults: %+v", base)
	}

	cfg := e.app.Config
	global, err := cfg.Create(ctx, admin.uid(), configprofiles.ProfileInput{
		Name: "Company", IsGlobal: true,
		Config:     json.RawMessage(`{"features":{"web_viewer":true},"sync":{"interval_seconds":120},"editor":{"fontSize":15}}`),
		LockedKeys: []string{"sync.interval_seconds"},
	})
	if err != nil {
		t.Fatal(err)
	}
	low, err := cfg.Create(ctx, admin.uid(), configprofiles.ProfileInput{Name: "Team", Config: json.RawMessage(`{"editor":{"fontSize":16,"lineWrap":true}}`), LockedKeys: []string{"editor.lineWrap"}})
	if err != nil {
		t.Fatal(err)
	}
	high, err := cfg.Create(ctx, admin.uid(), configprofiles.ProfileInput{Name: "Elite", Config: json.RawMessage(`{"editor":{"fontSize":20},"features":{"audio_recorder":true}}`)})
	if err != nil {
		t.Fatal(err)
	}
	if err := cfg.SetGroupAssignments(ctx, admin.uid(), team, []configprofiles.Assignment{{ProfileID: low.ID, Priority: 100}}); err != nil {
		t.Fatal(err)
	}
	if err := cfg.SetGroupAssignments(ctx, admin.uid(), elite, []configprofiles.Assignment{{ProfileID: high.ID, Priority: 200}}); err != nil {
		t.Fatal(err)
	}

	// carol is in no group: product defaults plus the global profile.
	got, etag := carol.effective()
	if sub(got.Config, "features")["web_viewer"] != true || sub(got.Config, "sync")["interval_seconds"] != float64(120) ||
		sub(got.Config, "editor")["fontSize"] != float64(15) || sub(got.Config, "editor")["lineWrap"] != nil {
		t.Fatalf("carol: %+v", got)
	}
	if len(got.LockedKeys) != 1 || got.LockedKeys[0] != "sync.interval_seconds" {
		t.Fatalf("carol locked: %v", got.LockedKeys)
	}

	// bob is in both groups: the higher priority wins, locked keys are united, untouched defaults survive.
	b, _ := bob.effective()
	if sub(b.Config, "editor")["fontSize"] != float64(20) || sub(b.Config, "editor")["lineWrap"] != true ||
		sub(b.Config, "features")["audio_recorder"] != true || sub(b.Config, "auth")["redirect_mode"] != "auto" {
		t.Fatalf("bob: %+v", b)
	}
	if len(b.LockedKeys) != 2 || b.LockedKeys[0] != "editor.lineWrap" || b.LockedKeys[1] != "sync.interval_seconds" {
		t.Fatalf("bob locked: %v", b.LockedKeys)
	}
	_ = global

	// ETag: unchanged config answers 304, any change moves the version.
	resp := carol.raw(http.MethodGet, "/config/effective", "", nil, map[string]string{"If-None-Match": etag})
	expect(t, resp, http.StatusNotModified)
	if _, err := cfg.Update(ctx, admin.uid(), global.ID, configprofiles.ProfileInput{Name: "Company", IsGlobal: true, Config: json.RawMessage(`{"sync":{"interval_seconds":300}}`)}); err != nil {
		t.Fatal(err)
	}
	after, etag2 := carol.effective()
	if after.Version <= got.Version || etag2 == etag || sub(after.Config, "sync")["interval_seconds"] != float64(300) || len(after.LockedKeys) != 0 {
		t.Fatalf("after the update: %+v", after)
	}
	if p, _ := cfg.Get(ctx, global.ID); p.Version != 2 {
		t.Fatalf("profile version %d", p.Version)
	}

	// Membership changes change what a user gets.
	if err := e.app.Groups.RemoveMember(ctx, admin.uid(), elite, bob.uid()); err != nil {
		t.Fatal(err)
	}
	if b, _ := bob.effective(); sub(b.Config, "editor")["fontSize"] != float64(16) {
		t.Fatalf("bob after leaving the elite group: %+v", b)
	}
}

func TestConfigValidationAndGlobalUniqueness(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	admin := e.user("admin")
	cfg := e.app.Config
	for name, in := range map[string]configprofiles.ProfileInput{
		"unknown key":        {Name: "a", Config: json.RawMessage(`{"nope":1}`)},
		"wrong type":         {Name: "b", Config: json.RawMessage(`{"sync":{"interval_seconds":"fast"}}`)},
		"out of range":       {Name: "c", Config: json.RawMessage(`{"sync":{"interval_seconds":1}}`)},
		"unknown locked key": {Name: "d", Config: json.RawMessage(`{}`), LockedKeys: []string{"made.up"}},
		"empty name":         {Name: " ", Config: json.RawMessage(`{}`)},
	} {
		if _, err := cfg.Create(ctx, admin.uid(), in); err == nil {
			t.Errorf("%s must be refused", name)
		}
	}
	first, err := cfg.Create(ctx, admin.uid(), configprofiles.ProfileInput{Name: "First", IsGlobal: true, Config: json.RawMessage(`{}`)})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := cfg.Create(ctx, admin.uid(), configprofiles.ProfileInput{Name: "first", Config: json.RawMessage(`{}`)}); err == nil {
		t.Error("names are unique, case-insensitively")
	}
	second, err := cfg.Create(ctx, admin.uid(), configprofiles.ProfileInput{Name: "Second", IsGlobal: true, Config: json.RawMessage(`{"editor":{"fontSize":13}}`)})
	if err != nil {
		t.Fatal(err)
	}
	if p, _ := cfg.Get(ctx, first.ID); p.IsGlobal {
		t.Error("a new global profile replaces the previous one")
	}
	if p, _ := cfg.Get(ctx, second.ID); !p.IsGlobal {
		t.Error("the new profile is global")
	}
	if err := cfg.Delete(ctx, admin.uid(), second.ID); err != nil {
		t.Fatal(err)
	}
	if got, _ := admin.effective(); sub(got.Config, "editor") != nil {
		t.Fatalf("after deleting the global profile: %+v", got)
	}
}

func TestConfigChangeIsAnnounced(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	admin, bob := e.user("admin"), e.user("bob")
	sub := e.app.Hub.Subscribe(bob.uid())
	defer e.app.Hub.Unsubscribe(sub)
	if _, err := e.app.Config.Create(ctx, admin.uid(), configprofiles.ProfileInput{Name: "G", IsGlobal: true, Config: json.RawMessage(`{}`)}); err != nil {
		t.Fatal(err)
	}
	wait, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	evs, err := sub.Next(wait)
	if err != nil || len(evs) != 1 || evs[0].Kind != notify.KindConfig || evs[0].Revision <= 0 {
		t.Fatalf("event: %+v %v", evs, err)
	}
	// A client that reconnects is told about a revision it has not seen.
	replay, err := e.app.Hub.Snapshot(ctx, bob.uid(), nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	var seen bool
	for _, ev := range replay {
		seen = seen || (ev.Kind == notify.KindConfig && ev.Revision == evs[0].Revision)
	}
	if !seen {
		t.Fatalf("replay: %+v", replay)
	}
	if replay, _ := e.app.Hub.Snapshot(ctx, bob.uid(), nil, evs[0].Revision); len(replay) != 0 {
		t.Fatalf("an up-to-date client needs no replay: %+v", replay)
	}
}
