//go:build integration

package integration

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"sync"
	"testing"
	"time"

	"clarae/services/cloud/internal/auth/authtest"
)

// TestServeLoadEnv is TEST-ONLY scaffolding for the k6 scripts in
// test/load/k6: it boots the whole API in this process (PostgreSQL in a
// container, filesystem blob storage, the in-process fake OIDC issuer),
// provisions CLARAE_LOADENV_USERS users that each own a shared vault with a few
// seeded files, writes their pre-minted tokens to CLARAE_LOADENV_OUT and keeps
// serving until the file "<out>.stop" appears or CLARAE_LOADENV_SECONDS pass.
//
//	CLARAE_LOADENV_USERS=1000 CLARAE_LOADENV_OUT=/tmp/tokens.json \
//	  go test -tags integration -run TestServeLoadEnv -timeout 1h ./test/integration/
//
// The fake issuer exists only in test binaries (package authtest takes a
// *testing.T); production builds and configurations cannot mint tokens.
func TestServeLoadEnv(t *testing.T) {
	out := os.Getenv("CLARAE_LOADENV_OUT")
	users, _ := strconv.Atoi(os.Getenv("CLARAE_LOADENV_USERS"))
	if out == "" || users <= 0 {
		t.Skip("set CLARAE_LOADENV_USERS and CLARAE_LOADENV_OUT to run the load environment")
	}
	seconds := 1800
	if n, err := strconv.Atoi(os.Getenv("CLARAE_LOADENV_SECONDS")); err == nil && n > 0 {
		seconds = n
	}
	seedFiles := 20
	if n, err := strconv.Atoi(os.Getenv("CLARAE_LOADENV_SEED_FILES")); err == nil && n >= 0 {
		seedFiles = n
	}
	e := newEnv(t)

	type loadUser struct {
		Token    string `json:"token"`
		VaultID  string `json:"vault_id"`
		DeviceID string `json:"device_id"`
	}
	list := make([]loadUser, users)
	var wg sync.WaitGroup
	sem := make(chan struct{}, 16)
	start := time.Now()
	for i := range list {
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			name := fmt.Sprintf("load%04d", i)
			c := &client{e: e, token: e.issuer.Token(t, authtest.TokenOptions{
				Subject: "sub-" + name, Username: name, Email: name + "@clarae.local", ExpiresIn: 6 * time.Hour,
			})}
			expect(t, c.json(http.MethodGet, "/me", nil), http.StatusOK)
			dev := decode[map[string]any](t, c.json(http.MethodPost, "/me/devices", map[string]any{"name": name, "platform": "linux"}))
			c.deviceID, _ = dev["id"].(string)
			vaultID := c.createVault("Load "+name, "shared")
			if seedFiles > 0 {
				h := c.putBlob(vaultID, []byte("seed "+name))
				ops := make([]map[string]any, 0, seedFiles)
				for j := 0; j < seedFiles; j++ {
					ops = append(ops, create(newID(), fmt.Sprintf("seed/n%03d.md", j), h))
				}
				for _, r := range c.commit(vaultID, ops...) {
					mustAccepted(t, r)
				}
			}
			list[i] = loadUser{Token: c.token, VaultID: vaultID, DeviceID: c.deviceID}
		}()
	}
	wg.Wait()
	t.Logf("provisioned %d users in %s", users, time.Since(start).Round(time.Millisecond))

	raw, err := json.Marshal(map[string]any{"base_url": e.baseURL, "users": list})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(out, raw, 0o600); err != nil { //nolint:gosec // developer-chosen output path
		t.Fatal(err)
	}
	t.Logf("ready: %s (tokens in %s); stop with: touch %s.stop", e.baseURL, out, out)
	stop := out + ".stop"
	_ = os.Remove(stop) //nolint:gosec // developer-chosen path
	deadline := time.After(time.Duration(seconds) * time.Second)
	for {
		select {
		case <-deadline:
			return
		case <-time.After(time.Second):
			if _, err := os.Stat(stop); err == nil { //nolint:gosec // developer-chosen path
				return
			}
		}
	}
}
