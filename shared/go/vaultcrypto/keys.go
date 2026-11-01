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
	"slices"
	"strings"
	"time"

	"golang.org/x/crypto/argon2"
	"golang.org/x/text/unicode/norm"
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

// DeriveKEKPassphrase derives the key-encryption key from the passphrase,
// normalized to Unicode NFC first: the same passphrase typed on keyboards or
// operating systems that produce composed or decomposed characters derives
// the same key. Every new envelope is wrapped under this key.
func DeriveKEKPassphrase(passphrase string, p KDFParams) ([KeySize]byte, error) {
	return DeriveKEKPassphraseRaw(norm.NFC.String(passphrase), p)
}

// DeriveKEKPassphraseRaw derives the key from the exact UTF-8 bytes of the
// passphrase, without normalization: the rule of the envelopes written before
// NFC normalization, kept to open them (see OpenWithPassphrase).
func DeriveKEKPassphraseRaw(passphrase string, p KDFParams) ([KeySize]byte, error) {
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

// Envelope formats (ADR-0034). v1 is nonce ‖ AES-256-GCM(KEK, VMK) ‖ tag
// without AAD, recognized by its length alone; v2 prefixes a version byte and
// binds the envelope to its vault and kind through the AAD
// "memobrain/v2/envelope" ‖ vault_id (16 bytes) ‖ kind.
const (
	WrappedSizeV1 = NonceSize + KeySize + TagSize // 60
	WrappedSizeV2 = 1 + WrappedSizeV1             // 61
	// EnvelopeV2 is the first byte of a v2 envelope.
	EnvelopeV2 byte = 0x02

	aadEnvelopeV2 = "memobrain/v2/envelope"
)

// EnvelopeKind names the secret an envelope is wrapped under; it is part of
// the v2 AAD.
type EnvelopeKind string

// Envelope kinds.
const (
	KindPassphrase EnvelopeKind = "passphrase"
	KindRecovery   EnvelopeKind = "recovery"
)

// EnvelopeAAD returns the additional data of a v2 envelope.
func EnvelopeAAD(vaultID [16]byte, kind EnvelopeKind) ([]byte, error) {
	if kind != KindPassphrase && kind != KindRecovery {
		return nil, fmt.Errorf("vaultcrypto: unknown envelope kind %q", kind)
	}
	aad := make([]byte, 0, len(aadEnvelopeV2)+16+len(kind))
	aad = append(aad, aadEnvelopeV2...)
	aad = append(aad, vaultID[:]...)
	return append(aad, kind...), nil
}

// EnvelopeVersion reports the format of a wrapped VMK from its length and
// version byte: 1, 2, or 0 when it is neither.
func EnvelopeVersion(wrapped []byte) int {
	switch {
	case len(wrapped) == WrappedSizeV1:
		return 1
	case len(wrapped) == WrappedSizeV2 && wrapped[0] == EnvelopeV2:
		return 2
	}
	return 0
}

// Wrap encrypts the VMK under the KEK in format v1: nonce ‖ ciphertext ‖ tag.
// It stays the default writer until every client reads v2 (ADR-0034).
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

// WrapV2 encrypts the VMK under the KEK in format v2, bound to the vault and
// to the envelope kind: 0x02 ‖ nonce ‖ ciphertext ‖ tag.
func WrapV2(kek [KeySize]byte, vmk VMK, vaultID [16]byte, kind EnvelopeKind) ([]byte, error) {
	return WrapV2WithNonce(kek, vmk, vaultID, kind, randomBytes(NonceSize))
}

// WrapV2WithNonce is WrapV2 with a caller-chosen nonce (test vectors only).
func WrapV2WithNonce(kek [KeySize]byte, vmk VMK, vaultID [16]byte, kind EnvelopeKind, nonce []byte) ([]byte, error) {
	aad, err := EnvelopeAAD(vaultID, kind)
	if err != nil {
		return nil, err
	}
	g, err := newGCM(kek[:])
	if err != nil {
		return nil, err
	}
	out := append([]byte{EnvelopeV2}, nonce...)
	return g.Seal(out, nonce, vmk[:], aad), nil
}

// Unwrap recovers the VMK from a v1 or v2 envelope; a v2 envelope opens only
// for the vault and kind it was written for. ErrDecrypt means the KEK is
// wrong (wrong passphrase or recovery key), the envelope belongs to another
// vault or kind, or it was altered.
func Unwrap(kek [KeySize]byte, wrapped []byte, vaultID [16]byte, kind EnvelopeKind) (VMK, error) {
	var vmk VMK
	var body, aad []byte
	switch EnvelopeVersion(wrapped) {
	case 1:
		body = wrapped
	case 2:
		var err error
		if aad, err = EnvelopeAAD(vaultID, kind); err != nil {
			return vmk, ErrDecrypt
		}
		body = wrapped[1:]
	default:
		return vmk, ErrDecrypt
	}
	g, err := newGCM(kek[:])
	if err != nil {
		return vmk, err
	}
	pt, err := g.Open(nil, body[:NonceSize], body[NonceSize:], aad)
	if err != nil {
		return vmk, ErrDecrypt
	}
	copy(vmk[:], pt)
	return vmk, nil
}

// PassphraseForms returns the encodings of a typed passphrase to try, in
// order, when opening an existing passphrase envelope: the NFC form (the rule
// of every envelope written since normalization was introduced), then the
// exact input and its NFD form, which open the envelopes written earlier from
// the raw bytes of a non-NFC input. Duplicates are dropped, so a passphrase
// that is already NFC and NFD (plain ASCII) costs one derivation.
func PassphraseForms(passphrase string) []string {
	forms := []string{norm.NFC.String(passphrase)}
	for _, f := range []string{passphrase, norm.NFD.String(passphrase)} {
		if !slices.Contains(forms, f) {
			forms = append(forms, f)
		}
	}
	return forms
}

// PassphraseUnlock is the result of OpenWithPassphrase.
type PassphraseUnlock struct {
	VMK VMK
	// KEK is derived from the NFC form under the envelope's KDF parameters,
	// even when a legacy form opened it: re-wrapping under it converges the
	// envelope to the current rule.
	KEK [KeySize]byte
	// Version is the format of the envelope that opened (1 or 2).
	Version int
	// Legacy reports that only a non-NFC form opened the envelope.
	Legacy bool
}

// OpenWithPassphrase derives the KEK from each form of the passphrase
// (PassphraseForms) and unwraps the envelope with the first that works.
// ErrWeakKDF is returned before any derivation; ErrDecrypt means no form
// opened it.
func OpenWithPassphrase(passphrase string, p KDFParams, wrapped []byte, vaultID [16]byte) (PassphraseUnlock, error) {
	var res PassphraseUnlock
	res.Version = EnvelopeVersion(wrapped)
	if res.Version == 0 {
		return res, ErrDecrypt
	}
	for i, form := range PassphraseForms(passphrase) {
		kek, err := DeriveKEKPassphraseRaw(form, p)
		if err != nil {
			return PassphraseUnlock{}, err
		}
		if i == 0 {
			res.KEK = kek
		}
		if vmk, err := Unwrap(kek, wrapped, vaultID, KindPassphrase); err == nil {
			res.VMK, res.Legacy = vmk, i > 0
			return res, nil
		}
	}
	return PassphraseUnlock{}, ErrDecrypt
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
