//go:build integration

package integration

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"testing"

	"github.com/google/uuid"

	"memobrain/services/cloud/internal/auth/authtest"
)

// client is one authenticated user with a registered device.
type client struct {
	e        *env
	token    string
	deviceID string
	userID   string
}

func (e *env) user(name string) *client {
	e.t.Helper()
	c := &client{e: e, token: e.issuer.Token(e.t, authtest.TokenOptions{Subject: "sub-" + name + "-" + uuid.NewString(), Username: name, Email: name + "-" + uuid.NewString()[:8] + "@memobrain.local"})}
	me := decode[map[string]any](e.t, c.json(http.MethodGet, "/me", nil))
	c.userID, _ = me["id"].(string)
	dev := decode[map[string]any](e.t, c.json(http.MethodPost, "/me/devices", map[string]any{"name": name + "-laptop", "platform": "linux"}))
	c.deviceID, _ = dev["id"].(string)
	return c
}

func (c *client) json(method, path string, body any) *http.Response {
	return c.e.request(method, path, c.token, body)
}

func (c *client) raw(method, path, contentType string, body []byte, headers map[string]string) *http.Response {
	c.e.t.Helper()
	req, err := http.NewRequestWithContext(context.Background(), method, c.e.baseURL+path, bytes.NewReader(body))
	if err != nil {
		c.e.t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	return c.e.do(req)
}

func hashOf(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func newID() string { return uuid.Must(uuid.NewV7()).String() }

func expect(t *testing.T, resp *http.Response, status int) {
	t.Helper()
	if resp.StatusCode != status {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("status %d, want %d: %s", resp.StatusCode, status, b)
	}
}

func (c *client) createVault(name, kind string) string {
	c.e.t.Helper()
	resp := c.json(http.MethodPost, "/vaults", map[string]any{"name": name, "kind": kind})
	expect(c.e.t, resp, http.StatusCreated)
	return decode[map[string]any](c.e.t, resp)["id"].(string)
}

func envelopes() []map[string]any {
	salt := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 16))
	wrapped := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{2}, 60))
	return []map[string]any{
		{"kind": "passphrase", "kdf": map[string]any{"alg": "argon2id", "t": 3, "m_kib": 65536, "p": 4, "salt": salt}, "wrapped_vmk": wrapped},
		{"kind": "recovery", "kdf": map[string]any{"alg": "hkdf-sha256", "salt": salt}, "wrapped_vmk": wrapped},
	}
}

func (c *client) createPrivateVault(name string) string {
	c.e.t.Helper()
	resp := c.json(http.MethodPost, "/vaults", map[string]any{"name": name, "kind": "private", "key_envelopes": envelopes()})
	expect(c.e.t, resp, http.StatusCreated)
	return decode[map[string]any](c.e.t, resp)["id"].(string)
}

func (c *client) putBlob(vault string, data []byte) string {
	c.e.t.Helper()
	h := hashOf(data)
	resp := c.raw(http.MethodPut, "/vaults/"+vault+"/blobs/"+h, "application/octet-stream", data, nil)
	expect(c.e.t, resp, http.StatusNoContent)
	return h
}

type result map[string]any

// commit sends ops and returns the per-op results.
func (c *client) commit(vault string, ops ...map[string]any) []result {
	c.e.t.Helper()
	resp := c.json(http.MethodPost, "/vaults/"+vault+"/commit", map[string]any{"device_id": c.deviceID, "ops": ops})
	expect(c.e.t, resp, http.StatusOK)
	out := decode[struct {
		Results []result `json:"results"`
		LastSeq float64  `json:"last_seq"`
	}](c.e.t, resp)
	return out.Results
}

func create(fileID, path, hash string) map[string]any {
	return map[string]any{"op_id": newID(), "op": "create", "file_id": fileID, "path": path, "blob_hash": hash}
}

func modify(fileID string, base int, hash string) map[string]any {
	return map[string]any{"op_id": newID(), "op": "modify", "file_id": fileID, "base_rev": base, "blob_hash": hash}
}

func move(fileID string, base int, path string) map[string]any {
	return map[string]any{"op_id": newID(), "op": "move", "file_id": fileID, "base_rev": base, "path": path}
}

func del(fileID string, base int) map[string]any {
	return map[string]any{"op_id": newID(), "op": "delete", "file_id": fileID, "base_rev": base}
}

func (r result) status() string { s, _ := r["status"].(string); return s }
func (r result) code() string   { s, _ := r["code"].(string); return s }
func (r result) rev() int       { f, _ := r["rev"].(float64); return int(f) }
func (r result) seq() int64     { f, _ := r["seq"].(float64); return int64(f) }

func mustAccepted(t *testing.T, r result) result {
	t.Helper()
	if r.status() != "accepted" {
		b, _ := json.Marshal(r)
		t.Fatalf("operation not accepted: %s", b)
	}
	return r
}

func (c *client) changes(vault string, since int64) (items []map[string]any, next int64, more bool) {
	c.e.t.Helper()
	resp := c.json(http.MethodGet, fmt.Sprintf("/vaults/%s/changes?since=%d", vault, since), nil)
	expect(c.e.t, resp, http.StatusOK)
	out := decode[struct {
		Items   []map[string]any `json:"items"`
		NextSeq float64          `json:"next_seq"`
		HasMore bool             `json:"has_more"`
	}](c.e.t, resp)
	return out.Items, int64(out.NextSeq), out.HasMore
}

func (c *client) tree(vault string) (paths map[string]map[string]any, asOf int64) {
	c.e.t.Helper()
	resp := c.json(http.MethodGet, "/vaults/"+vault+"/tree", nil)
	expect(c.e.t, resp, http.StatusOK)
	out := decode[struct {
		Items   []map[string]any `json:"items"`
		AsOfSeq float64          `json:"as_of_seq"`
	}](c.e.t, resp)
	paths = map[string]map[string]any{}
	for _, it := range out.Items {
		paths[it["path"].(string)] = it
	}
	return paths, int64(out.AsOfSeq)
}
