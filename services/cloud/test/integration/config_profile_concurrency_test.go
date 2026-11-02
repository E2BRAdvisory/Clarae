//go:build integration

package integration

import (
	"net/http"
	"sync"
	"testing"

	"github.com/google/uuid"
)

// Two administrators editing the same profile: an update made from an older version is refused
// (409 REV_CONFLICT) instead of silently replacing the change saved in the meantime.
func TestAdminConfigProfileUpdateChecksTheExpectedVersion(t *testing.T) {
	e := newEnv(t)
	root := e.admin("root")

	name := "Opt-" + uuid.NewString()[:6]
	resp := root.json(http.MethodPost, "/admin/config-profiles", map[string]any{
		"name": name, "config": map[string]any{"editor": map[string]any{"fontSize": 14}},
		// Ignored on create.
		"expected_version": 7,
	})
	expect(t, resp, http.StatusCreated)
	p := decode[map[string]any](t, resp)
	pid := p["id"].(string)
	if p["version"] != float64(1) {
		t.Fatalf("version %v", p["version"])
	}
	put := func(fontSize int, expected any) *http.Response {
		body := map[string]any{"name": name, "config": map[string]any{"editor": map[string]any{"fontSize": fontSize}}}
		if expected != nil {
			body["expected_version"] = expected
		}
		return root.json(http.MethodPut, "/admin/config-profiles/"+pid, body)
	}

	// The first administrator saves from version 1.
	resp = put(16, 1)
	expect(t, resp, http.StatusOK)
	if decode[map[string]any](t, resp)["version"] != float64(2) {
		t.Fatal("version after the first update")
	}
	// The second one still has version 1 on screen: refused, nothing changes.
	resp = put(18, 1)
	expect(t, resp, http.StatusConflict)
	if code := problemCode(t, resp); code != "REV_CONFLICT" {
		t.Fatalf("code %q", code)
	}
	resp = root.json(http.MethodGet, "/admin/config-profiles/"+pid, nil)
	expect(t, resp, http.StatusOK)
	cur := decode[map[string]any](t, resp)
	if cur["version"] != float64(2) || sub(cur["config"].(map[string]any), "editor")["fontSize"] != float64(16) {
		t.Fatalf("profile after the refused update: %v", cur)
	}
	resp = root.json(http.MethodGet, "/admin/config-profiles/"+pid+"/versions", nil)
	expect(t, resp, http.StatusOK)
	if vs := decode[[]map[string]any](t, resp); len(vs) != 2 {
		t.Fatalf("history after the refused update: %v", vs)
	}
	// Not a version: a validation error, not a conflict.
	expect(t, put(18, 0), http.StatusBadRequest)
	// Without expected_version the update replaces whatever is current (older clients).
	resp = put(20, nil)
	expect(t, resp, http.StatusOK)
	if decode[map[string]any](t, resp)["version"] != float64(3) {
		t.Fatal("version after an unchecked update")
	}

	// Two saves from the same version at the same time: exactly one wins.
	var wg sync.WaitGroup
	codes := make([]int, 2)
	for i := range codes {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r := put(30+i, 3)
			codes[i] = r.StatusCode
			_ = r.Body.Close()
		}()
	}
	wg.Wait()
	ok, conflict := 0, 0
	for _, c := range codes {
		switch c {
		case http.StatusOK:
			ok++
		case http.StatusConflict:
			conflict++
		}
	}
	if ok != 1 || conflict != 1 {
		t.Fatalf("concurrent updates from the same version: %v", codes)
	}
	resp = root.json(http.MethodGet, "/admin/config-profiles/"+pid, nil)
	expect(t, resp, http.StatusOK)
	if v := decode[map[string]any](t, resp)["version"]; v != float64(4) {
		t.Fatalf("version after the concurrent updates: %v", v)
	}

	// A profile that does not exist stays a 404 whatever the version.
	resp = root.json(http.MethodPut, "/admin/config-profiles/"+uuid.NewString(), map[string]any{"name": name, "config": map[string]any{}, "expected_version": 1})
	expect(t, resp, http.StatusNotFound)
}
