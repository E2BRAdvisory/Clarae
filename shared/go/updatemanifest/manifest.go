// Package updatemanifest defines the signed update manifest of the desktop
// client: format, ed25519 detached signature, validation and artifact
// selection. It uses only the standard library so that both the client
// (apps/desktop/internal/updater) and the release tool (tools/release) share
// one implementation.
//
// The signature covers the exact manifest bytes prefixed with a domain
// separator; callers MUST verify it before parsing (VerifyAndParse does).
//
// Freshness. Sequence and min_version stop a mirror from serving an older
// manifest, but not from serving the latest one it has forever (a freeze
// attack: clients never learn about a security release). A manifest can
// therefore carry a signed expires_at; the publisher re-signs it (a new
// sequence, same release) before it expires, every DefaultValidity or so. A
// client that finds it expired cannot tell a frozen mirror from a publisher
// that stopped re-signing, so it keeps working and warns the user (CheckFresh
// reports ErrExpired). The field is optional and lives in schema 1: older
// clients ignore it (unknown JSON field, the signature still covers it) and
// manifests without it, published before, never expire. A client that has
// seen an expiring manifest on a channel may treat a later one without
// expires_at as stale too.
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

// Validity of a manifest (expires_at - released_at). DefaultValidity is what
// the release tool should sign; MaxValidity bounds what clients accept, so a
// signing mistake cannot produce a manifest that is fresh for years.
const (
	DefaultValidity = 30 * 24 * time.Hour
	MaxValidity     = 400 * 24 * time.Hour
)

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
	MinVersion string    `json:"min_version,omitempty"`
	ReleasedAt time.Time `json:"released_at"`
	// ExpiresAt, when set, ends the manifest's freshness (see the package
	// documentation). It must follow ReleasedAt by at most MaxValidity.
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
	Notes     string     `json:"notes,omitempty"` // Markdown release notes
	NotesURL  string     `json:"notes_url,omitempty"`
	Artifacts []Artifact `json:"artifacts"`
}

// Errors returned by verification and validation.
var (
	ErrBadSignature = errors.New("updatemanifest: signature verification failed")
	ErrBadKey       = errors.New("updatemanifest: invalid key")
	// ErrExpired means the manifest is past its expires_at: the update
	// server may be frozen on an old manifest (CheckFresh).
	ErrExpired = errors.New("updatemanifest: manifest expired")
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
	if m.ExpiresAt != nil {
		if m.ReleasedAt.IsZero() || !m.ExpiresAt.After(m.ReleasedAt) {
			return errors.New("updatemanifest: expires_at must follow released_at")
		}
		if m.ExpiresAt.Sub(m.ReleasedAt) > MaxValidity {
			return fmt.Errorf("updatemanifest: expires_at more than %s after released_at", MaxValidity)
		}
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

// CheckFresh reports ErrExpired when now is past the manifest's expires_at.
// A manifest without expires_at (published before the field existed) is
// always fresh. Callers warn rather than fail: see the package documentation.
func (m *Manifest) CheckFresh(now time.Time) error {
	if m.ExpiresAt != nil && now.After(*m.ExpiresAt) {
		return fmt.Errorf("%w on %s", ErrExpired, m.ExpiresAt.UTC().Format(time.RFC3339))
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
