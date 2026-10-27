package updater

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"

	"memobrain/shared/updatemanifest"
)

// Build-time configuration, set with -ldflags "-X memobrain/apps/desktop/internal/updater.<name>=<value>".
// Release builds MUST set PublicKeyB64 (the release workflow refuses to build
// a tag with the development key) and ManifestBaseURL.
var (
	// PublicKeyB64 is the base64 ed25519 public key that verifies update manifests.
	// Empty means the DEVELOPMENT key, whose private half is derivable from the
	// public seed phrase below (see DevPrivateKey) and is therefore worthless.
	PublicKeyB64 = ""
	// ManifestBaseURL is where <channel>/manifest.json and <channel>/manifest.json.sig live.
	ManifestBaseURL = "https://updates.memobrain.example/desktop"
	// DisabledByBuild ("1") turns the updater off entirely (distribution packages
	// updated by a package manager, enterprise images).
	DisabledByBuild = ""
)

// devSeedPhrase derives the development key pair. It is intentionally public.
const devSeedPhrase = "memobrain-development-update-key-NOT-FOR-PRODUCTION"

// DevPrivateKey returns the development private key. It exists so tests and
// local update servers can sign manifests; it must never sign a release.
func DevPrivateKey() ed25519.PrivateKey {
	seed := sha256.Sum256([]byte(devSeedPhrase))
	return ed25519.NewKeyFromSeed(seed[:])
}

// DevPublicKeyB64 is the base64 public half of the development key.
func DevPublicKeyB64() string {
	return base64.StdEncoding.EncodeToString(DevPrivateKey().Public().(ed25519.PublicKey))
}

// IsDevKey reports whether the build uses the development key.
func IsDevKey() bool { return PublicKeyB64 == "" }

// publicKey returns the key verifying manifests for this build.
func publicKey() (ed25519.PublicKey, error) {
	if IsDevKey() {
		return DevPrivateKey().Public().(ed25519.PublicKey), nil
	}
	return updatemanifest.ParsePublicKey(PublicKeyB64)
}
