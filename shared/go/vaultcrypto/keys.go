// Package vaultcrypto implements the end-to-end encryption of private vaults
// (Specifications.md §3.8): the key hierarchy (passphrase/recovery key → KEK →
// VMK → subkeys), the chunked blob format "NDS1" and path encryption. The
// formats are fixed by shared/conformance/crypto/vectors.json, which the
// TypeScript implementation (packages/vaultcrypto-web) must reproduce.
package vaultcrypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"

	"golang.org/x/crypto/argon2"
)

// Sizes.
const (
	KeySize   = 32
	NonceSize = 12
	TagSize   = 16
	SaltSize  = 16
)

// Domain-separation labels (HKDF info), §3.8.2.
const (
	infoPathEnc     = "memobrain/v1/path-enc"
	infoPathKey     = "memobrain/v1/path-key"
	infoFile        = "memobrain/v1/file"
	infoRecoveryKEK = "memobrain/v1/recovery-kek"
)

// Errors.
var (
	// ErrDecrypt means authentication failed: wrong key, corrupted or
	// tampered data.
	ErrDecrypt = errors.New("vaultcrypto: decryption failed")
	// ErrWeakKDF means the stored KDF parameters are below the minimum (or
	// absurdly high); a hostile server could otherwise downgrade them.
	ErrWeakKDF = errors.New("vaultcrypto: unacceptable KDF parameters")
	// ErrRecoveryKey means the recovery key text is malformed or its checksum fails.
	ErrRecoveryKey = errors.New("vaultcrypto: invalid recovery key")
)

// VMK is the Vault Master Key: 256 random bits per vault.
type VMK [KeySize]byte

// GenerateVMK returns a fresh random VMK.
func GenerateVMK() (VMK, error) {
	var k VMK
	_, err := rand.Read(k[:])
	return k, err
}

// KDFParams is the "kdf" object stored in a key envelope.
type KDFParams struct {
	Alg  string `json:"alg"`
	T    uint32 `json:"t,omitempty"`
	MKiB uint32 `json:"m_kib,omitempty"`
	P    uint8  `json:"p,omitempty"`
	Salt string `json:"salt"` // standard base64
}

// KDF algorithm names.
const (
	AlgArgon2id = "argon2id"
	AlgHKDF     = "hkdf-sha256"
)

// Argon2id bounds (§3.8.2: minimum t=3, m=64 MiB, p=4).
const (
	MinT    = 3
	MinMKiB = 64 * 1024
	MinP    = 4
	maxT    = 12
	maxMKiB = 1024 * 1024
	maxP    = 16
)

func randomBytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err) // the OS CSPRNG failing is unrecoverable
	}
	return b
}

// NewPassphraseKDF returns Argon2id parameters with a fresh salt. Values
// below the minimum are raised to it.
func NewPassphraseKDF(t, mKiB uint32, p uint8) KDFParams {
	return KDFParams{
		Alg:  AlgArgon2id,
		T:    max(t, MinT),
		MKiB: max(mKiB, MinMKiB),
		P:    max(p, MinP),
		Salt: base64.StdEncoding.EncodeToString(randomBytes(SaltSize)),
	}
}

// CalibratePassphraseKDF raises the memory cost above the minimum until one
// derivation takes about target on this device (never above 512 MiB), so
// stronger hardware gets stronger parameters. The result is stored in the
// envelope and used on every device.
func CalibratePassphraseKDF(target time.Duration) KDFParams {
	p := NewPassphraseKDF(MinT, MinMKiB, MinP)
	salt, _ := base64.StdEncoding.DecodeString(p.Salt)
	for p.MKiB < 512*1024 {
		start := time.Now()
		_ = argon2.IDKey([]byte("calibration"), salt, p.T, p.MKiB, p.P, KeySize)
		if time.Since(start) >= target {
			break
		}
		p.MKiB *= 2
	}
	return p
}

// DeriveKEKPassphrase derives the key-encryption key from the passphrase.
func DeriveKEKPassphrase(passphrase string, p KDFParams) ([KeySize]byte, error) {
	var kek [KeySize]byte
	if p.Alg != AlgArgon2id || p.T < MinT || p.T > maxT || p.MKiB < MinMKiB || p.MKiB > maxMKiB || p.P < MinP || p.P > maxP {
		return kek, ErrWeakKDF
	}
	salt, err := base64.StdEncoding.DecodeString(p.Salt)
	if err != nil || len(salt) < 8 {
		return kek, fmt.Errorf("%w: bad salt", ErrWeakKDF)
	}
	copy(kek[:], argon2.IDKey([]byte(passphrase), salt, p.T, p.MKiB, p.P, KeySize))
	return kek, nil
}

// RecoveryKey is the 256-bit secret shown to the user once at creation.
type RecoveryKey [KeySize]byte

// GenerateRecoveryKey returns a fresh random recovery key.
func GenerateRecoveryKey() (RecoveryKey, error) {
	var k RecoveryKey
	_, err := rand.Read(k[:])
	return k, err
}

var b32 = base32.StdEncoding.WithPadding(base32.NoPadding)

func recoveryChecksum(k RecoveryKey) []byte {
	h := sha256.Sum256(append([]byte("memobrain/v1/recovery-checksum"), k[:]...))
	return h[:2]
}

// String renders the key as Base32 in groups of five, with a 16-bit checksum
// so typing mistakes are detected before any decryption attempt.
func (k RecoveryKey) String() string {
	raw := b32.EncodeToString(append(k[:], recoveryChecksum(k)...))
	var parts []string
	for i := 0; i < len(raw); i += 5 {
		parts = append(parts, raw[i:min(i+5, len(raw))])
	}
	return strings.Join(parts, "-")
}

// ParseRecoveryKey reverses String; dashes, spaces and case are ignored.
func ParseRecoveryKey(s string) (RecoveryKey, error) {
	var k RecoveryKey
	clean := strings.ToUpper(strings.NewReplacer("-", "", " ", "", "\n", "", "\t", "").Replace(s))
	raw, err := b32.DecodeString(clean)
	if err != nil || len(raw) != KeySize+2 {
		return k, ErrRecoveryKey
	}
	copy(k[:], raw[:KeySize])
	if string(raw[KeySize:]) != string(recoveryChecksum(k)) {
		return RecoveryKey{}, ErrRecoveryKey
	}
	return k, nil
}

// NewRecoveryKDF returns the envelope parameters for the recovery KEK.
func NewRecoveryKDF() KDFParams {
	return KDFParams{Alg: AlgHKDF, Salt: base64.StdEncoding.EncodeToString(randomBytes(SaltSize))}
}

// DeriveKEKRecovery derives the key-encryption key from the recovery key.
func DeriveKEKRecovery(rk RecoveryKey, p KDFParams) ([KeySize]byte, error) {
	var kek [KeySize]byte
	if p.Alg != AlgHKDF {
		return kek, fmt.Errorf("vaultcrypto: unsupported recovery kdf %q", p.Alg)
	}
	salt, err := base64.StdEncoding.DecodeString(p.Salt)
	if err != nil {
		return kek, err
	}
	k, err := hkdf.Key(sha256.New, rk[:], salt, infoRecoveryKEK, KeySize)
	if err != nil {
		return kek, err
	}
	copy(kek[:], k)
	return kek, nil
}

func newGCM(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// Wrap encrypts the VMK under the KEK: nonce ‖ ciphertext ‖ tag.
func Wrap(kek [KeySize]byte, vmk VMK) ([]byte, error) {
	return WrapWithNonce(kek, vmk, randomBytes(NonceSize))
}

// WrapWithNonce is Wrap with a caller-chosen nonce (test vectors only).
func WrapWithNonce(kek [KeySize]byte, vmk VMK, nonce []byte) ([]byte, error) {
	g, err := newGCM(kek[:])
	if err != nil {
		return nil, err
	}
	return g.Seal(append([]byte(nil), nonce...), nonce, vmk[:], nil), nil
}

// Unwrap recovers the VMK; ErrDecrypt means the KEK is wrong (wrong
// passphrase or recovery key) or the envelope was altered.
func Unwrap(kek [KeySize]byte, wrapped []byte) (VMK, error) {
	var vmk VMK
	if len(wrapped) != NonceSize+KeySize+TagSize {
		return vmk, ErrDecrypt
	}
	g, err := newGCM(kek[:])
	if err != nil {
		return vmk, err
	}
	pt, err := g.Open(nil, wrapped[:NonceSize], wrapped[NonceSize:], nil)
	if err != nil {
		return vmk, ErrDecrypt
	}
	copy(vmk[:], pt)
	return vmk, nil
}

// Subkeys are derived from the VMK (§3.8.2); the VMK itself is not used
// directly for data.
type Subkeys struct {
	PathEnc [KeySize]byte
	PathKey [KeySize]byte
	vmk     VMK
}

// DeriveSubkeys derives the path keys and keeps the VMK to derive per-file keys.
func DeriveSubkeys(vmk VMK) Subkeys {
	s := Subkeys{vmk: vmk}
	enc, _ := hkdf.Key(sha256.New, vmk[:], nil, infoPathEnc, KeySize)
	key, _ := hkdf.Key(sha256.New, vmk[:], nil, infoPathKey, KeySize)
	copy(s.PathEnc[:], enc)
	copy(s.PathKey[:], key)
	return s
}

// FileKey derives K_file for one file and one salt (a new salt per revision
// means a new key, so counter nonces never repeat under the same key).
func (s Subkeys) FileKey(fileID [16]byte, salt [SaltSize]byte) [KeySize]byte {
	info := append(append([]byte(infoFile), fileID[:]...), salt[:]...)
	k, _ := hkdf.Key(sha256.New, s.vmk[:], nil, string(info), KeySize)
	var out [KeySize]byte
	copy(out[:], k)
	return out
}
