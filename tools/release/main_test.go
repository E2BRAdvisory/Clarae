package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGenSignVerifyRoundTrip(t *testing.T) {
	dir := t.TempDir()
	art := filepath.Join(dir, "dist")
	if err := os.Mkdir(art, 0o755); err != nil { //nolint:gosec // test
		t.Fatal(err)
	}
	for _, n := range []string{"clarae-1.0.0-darwin-universal.dmg", "clarae-1.0.0-windows-amd64.exe", "clarae-1.0.0-linux-amd64.deb", "SHA256SUMS"} {
		if err := os.WriteFile(filepath.Join(art, n), []byte("payload "+n), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	mf := filepath.Join(dir, "manifest.json")
	var out bytes.Buffer
	if err := run([]string{"gen-manifest", "-channel", "stable", "-version", "v1.0.0", "-sequence", "3", "-artifacts-dir", art, "-base-url", "https://dl.example/rel", "-out", mf}, &out); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(mf)
	if strings.Count(string(raw), `"sha256"`) != 3 {
		t.Fatalf("expected 3 artifacts (SHA256SUMS ignored):\n%s", raw)
	}

	pub, priv, _ := ed25519.GenerateKey(rand.Reader) // throwaway test key
	t.Setenv("TEST_SIGNING_KEY", base64.StdEncoding.EncodeToString(priv))
	if err := run([]string{"sign-manifest", "-in", mf, "-key-env", "TEST_SIGNING_KEY"}, &out); err != nil {
		t.Fatal(err)
	}
	pubB64 := base64.StdEncoding.EncodeToString(pub)
	if err := run([]string{"verify-manifest", "-in", mf, "-pubkey", pubB64}, &out); err != nil {
		t.Fatalf("verify: %v", err)
	}

	// Tampering after signing is detected.
	if err := os.WriteFile(mf, bytes.Replace(raw, []byte("1.0.0"), []byte("9.0.0"), 1), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"verify-manifest", "-in", mf, "-pubkey", pubB64}, &out); err == nil {
		t.Fatal("tampered manifest verified")
	}
}

func TestSignRequiresKey(t *testing.T) {
	t.Setenv("CLARAE_UPDATE_SIGNING_KEY", "")
	f := filepath.Join(t.TempDir(), "m.json")
	_ = os.WriteFile(f, []byte("{}"), 0o600)
	if err := run([]string{"sign-manifest", "-in", f}, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "no signing key") {
		t.Fatalf("must fail loudly without a key: %v", err)
	}
}

func TestGenKeyAndPubkeyAgree(t *testing.T) {
	var out bytes.Buffer
	if err := run([]string{"gen-key"}, &out); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	priv := strings.TrimSpace(lines[0][strings.LastIndex(lines[0], ": ")+2:])
	pub := strings.TrimSpace(lines[1][strings.LastIndex(lines[1], ": ")+2:])
	t.Setenv("TEST_KEY", priv)
	var got bytes.Buffer
	if err := run([]string{"pubkey", "-key-env", "TEST_KEY"}, &got); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(got.String()) != pub {
		t.Fatalf("pubkey %q != %q", got.String(), pub)
	}
}
