package updatemanifest

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func sample() Manifest {
	return Manifest{
		Schema: 1, Channel: "stable", Version: "1.2.0", Sequence: 7, MinVersion: "1.0.0",
		ReleasedAt: time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC), Notes: "notes",
		Artifacts: []Artifact{
			{OS: "darwin", Arch: "universal", Kind: KindDMG, URL: "https://x.example/a.dmg", SHA256: strings.Repeat("a", 64), Size: 10},
			{OS: "linux", Arch: "amd64", Kind: KindDeb, URL: "https://x.example/a.deb", SHA256: strings.Repeat("b", 64), Size: 10},
		},
	}
}

func keys(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return pub, priv
}

func TestSignVerify(t *testing.T) {
	pub, priv := keys(t)
	raw, _ := json.Marshal(sample())
	sig, err := Sign(priv, raw)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyAndParse(pub, raw, []byte(sig+"\n")); err != nil {
		t.Fatalf("valid: %v", err)
	}
	tampered := []byte(strings.Replace(string(raw), "1.2.0", "9.9.9", 1))
	if _, err := VerifyAndParse(pub, tampered, []byte(sig)); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("tampered: %v", err)
	}
	other, _ := keys(t)
	if _, err := VerifyAndParse(other, raw, []byte(sig)); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("wrong key: %v", err)
	}
	for _, bad := range []string{"", "!!!", "AAAA"} {
		if err := Verify(pub, raw, []byte(bad)); !errors.Is(err, ErrBadSignature) {
			t.Fatalf("bad sig %q: %v", bad, err)
		}
	}
}

func TestValidate(t *testing.T) {
	mut := []func(*Manifest){
		func(m *Manifest) { m.Schema = 2 },
		func(m *Manifest) { m.Channel = "nightly" },
		func(m *Manifest) { m.Version = "x" },
		func(m *Manifest) { m.Sequence = 0 },
		func(m *Manifest) { m.MinVersion = "2.0.0" },
		func(m *Manifest) { m.Artifacts = nil },
		func(m *Manifest) { m.Artifacts[0].SHA256 = "zz" },
		func(m *Manifest) { m.Artifacts[0].URL = "ftp://x/y" },
		func(m *Manifest) { m.Artifacts[0].Size = 0 },
		func(m *Manifest) { m.Artifacts[0].Kind = "exe" },
	}
	for i, f := range mut {
		m := sample()
		f(&m)
		if m.Validate() == nil {
			t.Errorf("case %d: expected error", i)
		}
	}
	m := sample()
	if err := m.Validate(); err != nil {
		t.Fatal(err)
	}
}

// TestFreshness covers expires_at (manifest-no-freshness): optional and
// backward compatible, bounded at validation, reported by CheckFresh.
func TestFreshness(t *testing.T) {
	m := sample()
	released := m.ReleasedAt
	if err := m.CheckFresh(released.Add(10 * 365 * 24 * time.Hour)); err != nil {
		t.Fatalf("a manifest without expires_at never expires: %v", err)
	}
	// A legacy manifest (no expires_at) still verifies and parses; an old
	// client ignores the new field.
	pub, priv := keys(t)
	raw, _ := json.Marshal(m)
	if strings.Contains(string(raw), "expires_at") {
		t.Fatal("expires_at must be omitted when unset")
	}
	sig, _ := Sign(priv, raw)
	if _, err := VerifyAndParse(pub, raw, []byte(sig)); err != nil {
		t.Fatal(err)
	}
	exp := released.Add(DefaultValidity)
	m.ExpiresAt = &exp
	raw, _ = json.Marshal(m)
	sig, _ = Sign(priv, raw)
	got, err := VerifyAndParse(pub, raw, []byte(sig))
	if err != nil || got.ExpiresAt == nil || !got.ExpiresAt.Equal(exp) {
		t.Fatalf("signed expires_at: %v", err)
	}
	var legacy struct {
		Version  string `json:"version"`
		Sequence int64  `json:"sequence"`
	}
	if err := json.Unmarshal(raw, &legacy); err != nil || legacy.Version != m.Version {
		t.Fatalf("an older client must still parse it: %v", err)
	}
	if err := got.CheckFresh(exp.Add(-time.Second)); err != nil {
		t.Fatalf("fresh manifest reported %v", err)
	}
	if err := got.CheckFresh(exp.Add(time.Second)); !errors.Is(err, ErrExpired) {
		t.Fatalf("expired manifest: %v", err)
	}
	for _, bad := range []time.Time{released, released.Add(-time.Hour), released.Add(MaxValidity + time.Second)} {
		c := sample()
		c.ExpiresAt = &bad
		if c.Validate() == nil {
			t.Errorf("expires_at %s accepted", bad)
		}
	}
	c := sample()
	c.ReleasedAt = time.Time{}
	c.ExpiresAt = &exp
	if c.Validate() == nil {
		t.Error("expires_at without released_at accepted")
	}
}

func TestSelect(t *testing.T) {
	m := sample()
	if a, ok := m.Select("darwin", "arm64", []string{KindDMG}); !ok || a.Arch != "universal" {
		t.Fatalf("universal: %v %v", a, ok)
	}
	if _, ok := m.Select("linux", "arm64", []string{KindDeb}); ok {
		t.Fatal("arch mismatch must not match")
	}
	if a, ok := m.Select("linux", "amd64", []string{KindAppImage, KindDeb}); !ok || a.Kind != KindDeb {
		t.Fatalf("kind fallback: %v", a)
	}
}

func TestCompareVersions(t *testing.T) {
	order := []string{"1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.1.0", "v2.0.0"}
	for i, a := range order {
		for j, b := range order {
			c, err := CompareVersions(a, b)
			if err != nil {
				t.Fatal(err)
			}
			want := 0
			if i < j {
				want = -1
			} else if i > j {
				want = 1
			}
			if c != want {
				t.Errorf("%s vs %s = %d, want %d", a, b, c, want)
			}
		}
	}
	if c, _ := CompareVersions("1.0.0+a", "1.0.0+b"); c != 0 {
		t.Error("build metadata must be ignored")
	}
	for _, bad := range []string{"", "1.2", "01.2.3", "1.2.3-", "a.b.c", "dev"} {
		if _, err := ParseVersion(bad); err == nil {
			t.Errorf("%q should be invalid", bad)
		}
	}
}
