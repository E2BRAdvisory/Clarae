// Package hashing computes and parses the content-addressed identifiers used
// for blobs: SHA-256 over the raw bytes, serialized as lower-case hex.
package hashing

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
)

// Size is the length of a hash in bytes.
const Size = sha256.Size

// HexLen is the length of a hash in its hex representation (CHAR(64) in the schema).
const HexLen = Size * 2

// Hash is a SHA-256 digest.
type Hash [Size]byte

// ErrInvalidHash is returned by ParseHex for malformed input.
var ErrInvalidHash = errors.New("invalid sha256 hex")

// Hex returns the lower-case hex encoding.
func (h Hash) Hex() string { return hex.EncodeToString(h[:]) }

// String implements fmt.Stringer.
func (h Hash) String() string { return h.Hex() }

// IsZero reports whether h is the zero value (no hash).
func (h Hash) IsZero() bool { return h == Hash{} }

// Sum hashes an in-memory byte slice.
func Sum(b []byte) Hash { return Hash(sha256.Sum256(b)) }

// SumReader hashes everything read from r and also returns the byte count.
func SumReader(r io.Reader) (Hash, int64, error) {
	h := sha256.New()
	n, err := io.Copy(h, r)
	if err != nil {
		return Hash{}, n, err
	}
	var out Hash
	copy(out[:], h.Sum(nil))
	return out, n, nil
}

// ParseHex decodes a 64-character lower- or upper-case hex string.
func ParseHex(s string) (Hash, error) {
	if len(s) != HexLen {
		return Hash{}, ErrInvalidHash
	}
	b, err := hex.DecodeString(s)
	if err != nil {
		return Hash{}, ErrInvalidHash
	}
	var out Hash
	copy(out[:], b)
	return out, nil
}

// IsHex reports whether s is a well-formed hash string.
func IsHex(s string) bool {
	_, err := ParseHex(s)
	return err == nil
}
