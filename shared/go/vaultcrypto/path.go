package vaultcrypto

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"

	"memobrain/shared/pathrules"
)

// Prefixes of the opaque path tokens stored by the server (§3.8.3).
const (
	PathEncPrefix = "enc1:"
	PathKeyPrefix = "hmac1:"
)

// ParseUUID parses the canonical text form into its 16 bytes.
func ParseUUID(s string) ([16]byte, error) {
	var id [16]byte
	h := strings.ReplaceAll(s, "-", "")
	if len(h) != 32 {
		return id, fmt.Errorf("vaultcrypto: bad uuid %q", s)
	}
	b, err := hex.DecodeString(h)
	if err != nil {
		return id, fmt.Errorf("vaultcrypto: bad uuid %q", s)
	}
	copy(id[:], b)
	return id, nil
}

// EncryptPath returns "enc1:" + base64url(nonce ‖ AES-GCM(K_path_enc, NFC path; AAD = vault_id)).
func EncryptPath(s Subkeys, vaultID [16]byte, path string) (string, error) {
	return EncryptPathWithNonce(s, vaultID, path, randomBytes(NonceSize))
}

// EncryptPathWithNonce is EncryptPath with a caller-chosen nonce (vectors only).
func EncryptPathWithNonce(s Subkeys, vaultID [16]byte, path string, nonce []byte) (string, error) {
	norm, err := pathrules.Normalize(path)
	if err != nil {
		return "", err
	}
	g, err := newGCM(s.PathEnc[:])
	if err != nil {
		return "", err
	}
	sealed := g.Seal(append([]byte(nil), nonce...), nonce, []byte(norm), vaultID[:])
	return PathEncPrefix + base64.RawURLEncoding.EncodeToString(sealed), nil
}

// DecryptPath reverses EncryptPath.
func DecryptPath(s Subkeys, vaultID [16]byte, token string) (string, error) {
	enc, ok := strings.CutPrefix(token, PathEncPrefix)
	if !ok {
		return "", ErrFormat
	}
	raw, err := base64.RawURLEncoding.DecodeString(enc)
	if err != nil || len(raw) < NonceSize+TagSize {
		return "", ErrFormat
	}
	g, err := newGCM(s.PathEnc[:])
	if err != nil {
		return "", err
	}
	pt, err := g.Open(nil, raw[:NonceSize], raw[NonceSize:], vaultID[:])
	if err != nil {
		return "", ErrDecrypt
	}
	return string(pt), nil
}

// PathKey returns "hmac1:" + hex(HMAC-SHA256(K_path_key, NFC+casefold(path))):
// the deterministic identifier the server uses for uniqueness
// (PATH_COLLISION) without learning the path.
func PathKey(s Subkeys, path string) (string, error) {
	norm, err := pathrules.Normalize(path)
	if err != nil {
		return "", err
	}
	m := hmac.New(sha256.New, s.PathKey[:])
	m.Write([]byte(pathrules.Key(norm)))
	return PathKeyPrefix + hex.EncodeToString(m.Sum(nil)), nil
}
