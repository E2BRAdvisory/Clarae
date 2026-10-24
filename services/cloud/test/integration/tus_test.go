//go:build integration

package integration

import (
	"bytes"
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"strconv"
	"testing"
)

func ctxBg() context.Context { return context.Background() }

// tus requests are not described by the OpenAPI document (tus is its own
// protocol), so they bypass the spec validation of e.do.
func (c *client) tus(method, url string, headers map[string]string, body []byte) *http.Response {
	c.e.t.Helper()
	if url[0] == '/' {
		url = c.e.server.URL + url
	}
	req, err := http.NewRequestWithContext(ctxBg(), method, url, bytes.NewReader(body))
	if err != nil {
		c.e.t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Tus-Resumable", "1.0.0")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.e.t.Fatal(err)
	}
	return resp
}

func (c *client) tusCreate(vault string, data []byte, hash string) *http.Response {
	meta := "sha256 " + base64.StdEncoding.EncodeToString([]byte(hash))
	return c.tus(http.MethodPost, "/api/v1/vaults/"+vault+"/uploads", map[string]string{"Upload-Length": strconv.Itoa(len(data)), "Upload-Metadata": meta}, nil)
}

func (c *client) tusPatch(loc string, offset int, chunk []byte) *http.Response {
	return c.tus(http.MethodPatch, loc, map[string]string{"Upload-Offset": strconv.Itoa(offset), "Content-Type": "application/offset+octet-stream"}, chunk)
}

func TestTusResumableUpload(t *testing.T) {
	e := newEnv(t)
	ada, bob := e.user("ada"), e.user("bob")
	v := ada.createVault("Big", "shared")
	data := bytes.Repeat([]byte("0123456789"), 10) // 100 bytes in 3 chunks
	h := hashOf(data)

	resp := ada.tusCreate(v, data, h)
	if resp.StatusCode != http.StatusCreated {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("create: %d %s", resp.StatusCode, b)
	}
	loc := resp.Header.Get("Location")
	if loc == "" || resp.Header.Get("Tus-Resumable") != "1.0.0" {
		t.Fatalf("headers: %v", resp.Header)
	}

	// Somebody else cannot see or continue the upload.
	if r := bob.tus(http.MethodHead, loc, nil, nil); r.StatusCode != http.StatusNotFound {
		t.Fatalf("foreign HEAD: %d", r.StatusCode)
	}

	if r := ada.tusPatch(loc, 0, data[:40]); r.StatusCode != http.StatusNoContent || r.Header.Get("Upload-Offset") != "40" {
		t.Fatalf("patch 1: %d %v", r.StatusCode, r.Header)
	}
	// The client lost the response and asks where to continue.
	r := ada.tus(http.MethodHead, loc, nil, nil)
	if r.Header.Get("Upload-Offset") != "40" || r.Header.Get("Upload-Length") != "100" {
		t.Fatalf("HEAD: %v", r.Header)
	}
	// Writing at a wrong offset is refused.
	if r := ada.tusPatch(loc, 10, data[10:20]); r.StatusCode == http.StatusNoContent {
		t.Fatal("wrong offset accepted")
	}
	if r := ada.tusPatch(loc, 40, data[40:70]); r.StatusCode != http.StatusNoContent {
		t.Fatalf("patch 2: %d", r.StatusCode)
	}
	// Not published until complete.
	chk := decode[struct{ Missing []string }](t, ada.json(http.MethodPost, "/vaults/"+v+"/blobs:check", map[string]any{"hashes": []string{h}}))
	if len(chk.Missing) != 1 {
		t.Fatal("blob visible before the upload finished")
	}
	if r := ada.tusPatch(loc, 70, data[70:]); r.StatusCode != http.StatusNoContent || r.Header.Get("Upload-Offset") != "100" {
		t.Fatalf("patch 3: %d", r.StatusCode)
	}
	resp = ada.json(http.MethodGet, "/vaults/"+v+"/blobs/"+h, nil)
	expect(t, resp, http.StatusOK)
	if got, _ := io.ReadAll(resp.Body); !bytes.Equal(got, data) {
		t.Fatal("downloaded content differs")
	}
	// It can be committed like any blob.
	mustAccepted(t, ada.commit(v, create(newID(), "big.bin", h))[0])
	// The session is gone.
	if r := ada.tus(http.MethodHead, loc, nil, nil); r.StatusCode != http.StatusNotFound {
		t.Fatalf("finished upload still exists: %d", r.StatusCode)
	}
}

func TestTusRejectsBadInput(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createVault("Tus", "shared")
	data := bytes.Repeat([]byte{'z'}, 30)

	// Digest announced at creation must match the content, or nothing is published.
	resp := ada.tusCreate(v, data, hashOf([]byte("something else")))
	loc := resp.Header.Get("Location")
	if r := ada.tusPatch(loc, 0, data); r.StatusCode != http.StatusBadRequest {
		t.Fatalf("hash mismatch must fail, got %d", r.StatusCode)
	}
	if r := ada.tus(http.MethodHead, loc, nil, nil); r.StatusCode != http.StatusNotFound {
		t.Fatalf("failed upload must be discarded: %d", r.StatusCode)
	}

	// Missing digest, missing length, oversize announcements.
	if r := ada.tus(http.MethodPost, "/api/v1/vaults/"+v+"/uploads", map[string]string{"Upload-Length": "10"}, nil); r.StatusCode != http.StatusBadRequest {
		t.Fatalf("missing sha256: %d", r.StatusCode)
	}
	meta := "sha256 " + base64.StdEncoding.EncodeToString([]byte(hashOf(data)))
	if r := ada.tus(http.MethodPost, "/api/v1/vaults/"+v+"/uploads", map[string]string{"Upload-Metadata": meta}, nil); r.StatusCode != http.StatusBadRequest {
		t.Fatalf("missing length: %d", r.StatusCode)
	}
	if r := ada.tus(http.MethodPost, "/api/v1/vaults/"+v+"/uploads", map[string]string{"Upload-Length": strconv.Itoa(1 << 30), "Upload-Metadata": meta}, nil); r.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize: %d", r.StatusCode)
	}
	// Overrunning the announced length.
	resp = ada.tusCreate(v, data, hashOf(data))
	loc = resp.Header.Get("Location")
	if r := ada.tusPatch(loc, 0, append(data, 'x')); r.StatusCode != http.StatusBadRequest {
		t.Fatalf("overrun: %d", r.StatusCode)
	}
	// tus version header is mandatory; termination works.
	req, _ := http.NewRequestWithContext(ctxBg(), http.MethodHead, e.server.URL+loc, nil)
	req.Header.Set("Authorization", "Bearer "+ada.token)
	if r, _ := http.DefaultClient.Do(req); r.StatusCode != http.StatusBadRequest {
		t.Fatalf("missing Tus-Resumable: %d", r.StatusCode)
	}
	if r := ada.tus(http.MethodDelete, loc, nil, nil); r.StatusCode != http.StatusNoContent {
		t.Fatalf("terminate: %d", r.StatusCode)
	}
	// No token, no upload.
	req, _ = http.NewRequestWithContext(ctxBg(), http.MethodPost, e.server.URL+"/api/v1/vaults/"+v+"/uploads", nil)
	req.Header.Set("Tus-Resumable", "1.0.0")
	if r, _ := http.DefaultClient.Do(req); r.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated tus: %d", r.StatusCode)
	}
}
