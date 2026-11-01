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
//
// enc1 binds the encrypted path to the vault only (AAD = vault_id), so a
// malicious server could hand a client one file's token for another file of
// the same vault. enc2 (ADR-0042) binds it to the file as well:
//
//	enc2 = "enc2:" + base64url(nonce(12) ‖ AES-256-GCM(K_path_enc, NFC path; AAD) ‖ tag(16))
//	AAD  = "memobrain/v2/path" (17 B ASCII) ‖ vault_id (16 B) ‖ file_id (16 B)
//
// Both versions use the same key; their AADs differ in length and prefix, so
// a token relabelled from one version to the other never opens. The path key
// (hmac1) does not depend on the token version.
const (
	PathEncPrefix   = "enc1:"
	PathEncPrefixV2 = "enc2:"
	PathKeyPrefix   = "hmac1:"

	aadPathV2 = "memobrain/v2/path"
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

// PathAADV2 returns the additional data of an enc2 token.
func PathAADV2(vaultID, fileID [16]byte) []byte {
	aad := make([]byte, 0, len(aadPathV2)+32)
	aad = append(aad, aadPathV2...)
	aad = append(aad, vaultID[:]...)
	return append(aad, fileID[:]...)
}

// PathTokenVersion reports the format of a path token from its prefix: 1, 2,
// or 0 when it is neither (it says nothing about the token being valid).
func PathTokenVersion(token string) int {
	switch {
	case strings.HasPrefix(token, PathEncPrefix):
		return 1
	case strings.HasPrefix(token, PathEncPrefixV2):
		return 2
	}
	return 0
}

// EncryptPath returns the enc1 token of a path: "enc1:" + base64url(nonce ‖
// AES-GCM(K_path_enc, NFC path; AAD = vault_id)). It stays the default writer
// until every client reads enc2 (ADR-0042).
func EncryptPath(s *Subkeys, vaultID [16]byte, path string) (string, error) {
	return EncryptPathWithNonce(s, vaultID, path, randomBytes(NonceSize))
}

// EncryptPathWithNonce is EncryptPath with a caller-chosen nonce (vectors only).
func EncryptPathWithNonce(s *Subkeys, vaultID [16]byte, path string, nonce []byte) (string, error) {
	return sealPath(s, PathEncPrefix, vaultID[:], path, nonce)
}

// EncryptPathV2 returns the enc2 token of the path of one file, bound to the
// vault and to the file id.
func EncryptPathV2(s *Subkeys, vaultID, fileID [16]byte, path string) (string, error) {
	return EncryptPathV2WithNonce(s, vaultID, fileID, path, randomBytes(NonceSize))
}

// EncryptPathV2WithNonce is EncryptPathV2 with a caller-chosen nonce (vectors only).
func EncryptPathV2WithNonce(s *Subkeys, vaultID, fileID [16]byte, path string, nonce []byte) (string, error) {
	return sealPath(s, PathEncPrefixV2, PathAADV2(vaultID, fileID), path, nonce)
}

func sealPath(s *Subkeys, prefix string, aad []byte, path string, nonce []byte) (string, error) {
	if err := s.usable(); err != nil {
		return "", err
	}
	if len(nonce) != NonceSize {
		return "", fmt.Errorf("vaultcrypto: nonce must be %d bytes", NonceSize)
	}
	// A token is only written for a path entering the vault (create, move):
	// the server cannot check the names of a private vault, so the complete
	// portability rule is applied here (pathrules.NormalizePortable).
	norm, err := pathrules.NormalizePortable(path)
	if err != nil {
		return "", err
	}
	g, err := newGCM(s.PathEnc[:])
	if err != nil {
		return "", err
	}
	sealed := g.Seal(append([]byte(nil), nonce...), nonce, []byte(norm), aad)
	return prefix + base64.RawURLEncoding.EncodeToString(sealed), nil
}

// DecryptPath opens an enc1 token. An enc2 token needs the file id it is
// bound to (DecryptPathFor) and is refused here with ErrFormat.
func DecryptPath(s *Subkeys, vaultID [16]byte, token string) (string, error) {
	enc, ok := strings.CutPrefix(token, PathEncPrefix)
	if !ok {
		return "", ErrFormat
	}
	return openPath(s, vaultID[:], enc)
}

// DecryptPathFor opens the path token of one file, in either format: an enc1
// token is checked against the vault, an enc2 token against the vault and the
// file. ErrDecrypt means the token was altered, belongs to another vault or
// (enc2) to another file; ErrFormat means it is not a path token.
func DecryptPathFor(s *Subkeys, vaultID, fileID [16]byte, token string) (string, error) {
	switch PathTokenVersion(token) {
	case 1:
		return openPath(s, vaultID[:], token[len(PathEncPrefix):])
	case 2:
		return openPath(s, PathAADV2(vaultID, fileID), token[len(PathEncPrefixV2):])
	}
	return "", ErrFormat
}

func openPath(s *Subkeys, aad []byte, enc string) (string, error) {
	if err := s.usable(); err != nil {
		return "", err
	}
	raw, err := base64.RawURLEncoding.DecodeString(enc)
	if err != nil || len(raw) < NonceSize+TagSize {
		return "", ErrFormat
	}
	g, err := newGCM(s.PathEnc[:])
	if err != nil {
		return "", err
	}
	pt, err := g.Open(nil, raw[:NonceSize], raw[NonceSize:], aad)
	if err != nil {
		return "", ErrDecrypt
	}
	return string(pt), nil
}

// PathKey returns "hmac1:" + hex(HMAC-SHA256(K_path_key, NFC+casefold(path))):
// the deterministic identifier the server uses for uniqueness
// (PATH_COLLISION) without learning the path.
func PathKey(s *Subkeys, path string) (string, error) {
	if err := s.usable(); err != nil {
		return "", err
	}
	norm, err := pathrules.Normalize(path)
	if err != nil {
		return "", err
	}
	m := hmac.New(sha256.New, s.PathKey[:])
	m.Write([]byte(pathrules.Key(norm)))
	return PathKeyPrefix + hex.EncodeToString(m.Sum(nil)), nil
}
