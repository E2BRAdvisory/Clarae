// Package updatemanifest defines the signed update manifest of the desktop
// client: format, ed25519 detached signature, validation and artifact
// selection. It uses only the standard library so that both the client
// (apps/desktop/internal/updater) and the release tool (tools/release) share
// one implementation.
//
// The signature covers the exact manifest bytes prefixed with a domain
// separator; callers MUST verify it before parsing (VerifyAndParse does).
package updatemanifest

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
)

// SchemaVersion is the only manifest schema understood by this code.
const SchemaVersion = 1

// signContext is prepended to the manifest bytes before signing (domain separation).
const signContext = "memobrain-update-manifest-v1\n"

// MaxArtifactSize is a hard cap on any single artifact (2 GiB).
const MaxArtifactSize int64 = 2 << 30

// Channels.
const (
	ChannelStable = "stable"
	ChannelBeta   = "beta"
)

// Artifact kinds.
const (
	KindDMG      = "dmg"      // macOS notarised disk image
	KindNSIS     = "nsis"     // Windows installer (.exe)
	KindAppImage = "appimage" // Linux AppImage
	KindDeb      = "deb"      // Linux Debian package
)

// Artifact is one downloadable file of a release.
type Artifact struct {
	OS     string `json:"os"`   // darwin | windows | linux
	Arch   string `json:"arch"` // amd64 | arm64 | universal
	Kind   string `json:"kind"`
	URL    string `json:"url"`
	SHA256 string `json:"sha256"` // lowercase hex
	Size   int64  `json:"size"`
}

// Manifest describes the latest release of a channel.
type Manifest struct {
	Schema  int    `json:"schema"`
	Channel string `json:"channel"`
	Version string `json:"version"`
	// Sequence grows with every published manifest of a channel. Clients
	// remember the highest value seen and reject lower ones (replay/rollback).
	Sequence int64 `json:"sequence"`
	// MinVersion is the revocation floor: versions below it must not be
	// offered or installed. Clients remember the highest floor seen; a client
	// older than the floor is told the update is required.
	MinVersion string     `json:"min_version,omitempty"`
	ReleasedAt time.Time  `json:"released_at"`
	Notes      string     `json:"notes,omitempty"` // Markdown release notes
	NotesURL   string     `json:"notes_url,omitempty"`
	Artifacts  []Artifact `json:"artifacts"`
}

// Errors returned by verification and validation.
var (
	ErrBadSignature = errors.New("updatemanifest: signature verification failed")
	ErrBadKey       = errors.New("updatemanifest: invalid key")
)

// Sign returns the base64 detached signature of the manifest bytes.
func Sign(priv ed25519.PrivateKey, manifest []byte) (string, error) {
	if len(priv) != ed25519.PrivateKeySize {
		return "", ErrBadKey
	}
	return base64.StdEncoding.EncodeToString(ed25519.Sign(priv, signedBytes(manifest))), nil
}

// Verify checks the base64 detached signature over the exact manifest bytes.
func Verify(pub ed25519.PublicKey, manifest, sigB64 []byte) error {
	if len(pub) != ed25519.PublicKeySize {
		return ErrBadKey
	}
	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(sigB64)))
	if err != nil || len(sig) != ed25519.SignatureSize {
		return ErrBadSignature
	}
	if !ed25519.Verify(pub, signedBytes(manifest), sig) {
		return ErrBadSignature
	}
	return nil
}

func signedBytes(manifest []byte) []byte {
	return append([]byte(signContext), manifest...)
}

// VerifyAndParse verifies the signature first and only then parses and validates.
func VerifyAndParse(pub ed25519.PublicKey, manifest, sigB64 []byte) (*Manifest, error) {
	if err := Verify(pub, manifest, sigB64); err != nil {
		return nil, err
	}
	var m Manifest
	if err := json.Unmarshal(manifest, &m); err != nil {
		return nil, fmt.Errorf("updatemanifest: parse: %w", err)
	}
	if err := m.Validate(); err != nil {
		return nil, err
	}
	return &m, nil
}

// ParsePublicKey decodes a base64 ed25519 public key.
func ParsePublicKey(b64 string) (ed25519.PublicKey, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(b64))
	if err != nil || len(raw) != ed25519.PublicKeySize {
		return nil, ErrBadKey
	}
	return ed25519.PublicKey(raw), nil
}

// ParsePrivateKey decodes a base64 ed25519 private key: the 64-byte form or the 32-byte seed.
func ParsePrivateKey(b64 string) (ed25519.PrivateKey, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(b64))
	if err != nil {
		return nil, ErrBadKey
	}
	switch len(raw) {
	case ed25519.PrivateKeySize:
		return ed25519.PrivateKey(raw), nil
	case ed25519.SeedSize:
		return ed25519.NewKeyFromSeed(raw), nil
	}
	return nil, ErrBadKey
}

// Validate checks structure and values (it does not check the signature).
func (m *Manifest) Validate() error {
	if m.Schema != SchemaVersion {
		return fmt.Errorf("updatemanifest: unsupported schema %d", m.Schema)
	}
	if m.Channel != ChannelStable && m.Channel != ChannelBeta {
		return fmt.Errorf("updatemanifest: invalid channel %q", m.Channel)
	}
	if _, err := ParseVersion(m.Version); err != nil {
		return err
	}
	if m.MinVersion != "" {
		if _, err := ParseVersion(m.MinVersion); err != nil {
			return err
		}
		if c, _ := CompareVersions(m.Version, m.MinVersion); c < 0 {
			return errors.New("updatemanifest: version is below min_version")
		}
	}
	if m.Sequence < 1 {
		return errors.New("updatemanifest: sequence must be positive")
	}
	if len(m.Artifacts) == 0 {
		return errors.New("updatemanifest: no artifacts")
	}
	for i, a := range m.Artifacts {
		if err := a.validate(); err != nil {
			return fmt.Errorf("updatemanifest: artifact %d: %w", i, err)
		}
	}
	return nil
}

func (a Artifact) validate() error {
	switch a.OS {
	case "darwin", "windows", "linux":
	default:
		return fmt.Errorf("invalid os %q", a.OS)
	}
	switch a.Arch {
	case "amd64", "arm64", "universal":
	default:
		return fmt.Errorf("invalid arch %q", a.Arch)
	}
	switch a.Kind {
	case KindDMG, KindNSIS, KindAppImage, KindDeb:
	default:
		return fmt.Errorf("invalid kind %q", a.Kind)
	}
	u, err := url.Parse(a.URL)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return fmt.Errorf("invalid url %q", a.URL)
	}
	if raw, err := hex.DecodeString(a.SHA256); err != nil || len(raw) != 32 || a.SHA256 != strings.ToLower(a.SHA256) {
		return errors.New("sha256 must be 64 lowercase hex characters")
	}
	if a.Size <= 0 || a.Size > MaxArtifactSize {
		return fmt.Errorf("invalid size %d", a.Size)
	}
	return nil
}

// Select returns the artifact for the platform, trying the kinds in order of
// preference; "universal" matches any architecture of that OS.
func (m *Manifest) Select(goos, goarch string, kinds []string) (Artifact, bool) {
	for _, k := range kinds {
		var universal *Artifact
		for i := range m.Artifacts {
			a := m.Artifacts[i]
			if a.OS != goos || a.Kind != k {
				continue
			}
			if a.Arch == goarch {
				return a, true
			}
			if a.Arch == "universal" {
				universal = &m.Artifacts[i]
			}
		}
		if universal != nil {
			return *universal, true
		}
	}
	return Artifact{}, false
}
