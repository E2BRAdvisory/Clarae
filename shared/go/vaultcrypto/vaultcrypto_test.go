package vaultcrypto_test

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/text/unicode/norm"

	"memobrain/shared/vaultcrypto"
)

var (
	vaultID = mustUUID("0194f0a8-0000-7000-8000-00000000aaaa")
	fileID  = mustUUID("0194f0a8-5e1c-7b1d-9a3e-2b8f4e7c1a10")
)

func mustUUID(s string) [16]byte {
	id, err := vaultcrypto.ParseUUID(s)
	if err != nil {
		panic(err)
	}
	return id
}

func testSubkeys(t *testing.T) vaultcrypto.Subkeys {
	t.Helper()
	vmk, err := vaultcrypto.GenerateVMK()
	if err != nil {
		t.Fatal(err)
	}
	return vaultcrypto.DeriveSubkeys(vmk)
}

func TestBlobRoundTripAtChunkBoundaries(t *testing.T) {
	s := testSubkeys(t)
	cs := vaultcrypto.DefaultChunkSize
	for _, n := range []int{0, 1, cs - 1, cs, cs + 1, 2 * cs, 2*cs + 7, 3 * cs} {
		pt := make([]byte, n)
		_, _ = rand.Read(pt)
		blob, err := vaultcrypto.Encrypt(s, vaultID, fileID, pt)
		if err != nil {
			t.Fatalf("n=%d: %v", n, err)
		}
		if int64(len(blob)) != vaultcrypto.EncryptedSize(int64(n), cs) {
			t.Errorf("n=%d: size %d, want %d", n, len(blob), vaultcrypto.EncryptedSize(int64(n), cs))
		}
		got, err := vaultcrypto.Decrypt(s, vaultID, fileID, blob)
		if err != nil || !bytes.Equal(got, pt) {
			t.Fatalf("n=%d: round trip failed: %v", n, err)
		}
	}
}

func TestBlobRejectsTamperingAndMisuse(t *testing.T) {
	s := testSubkeys(t)
	var salt [16]byte
	pt := bytes.Repeat([]byte("x"), 100)
	var buf bytes.Buffer
	if err := vaultcrypto.EncryptBlobWith(&buf, bytes.NewReader(pt), s, vaultID, fileID, salt, 32); err != nil {
		t.Fatal(err)
	}
	blob := buf.Bytes()
	const hdr, chunk = 25, 32 + 16
	dec := func(b []byte, v, f [16]byte, k vaultcrypto.Subkeys) error {
		return vaultcrypto.DecryptBlob(&bytes.Buffer{}, bytes.NewReader(b), k, v, f)
	}
	if err := dec(blob, vaultID, fileID, s); err != nil {
		t.Fatalf("valid blob: %v", err)
	}

	flip := append([]byte(nil), blob...)
	flip[hdr+3] ^= 1
	if !errors.Is(dec(flip, vaultID, fileID, s), vaultcrypto.ErrDecrypt) {
		t.Error("flipped ciphertext bit must fail")
	}
	// Dropping the last chunk is truncation: the previous chunk is not flagged last.
	trunc := blob[:len(blob)-(len(pt)-3*32+16)]
	if err := dec(trunc, vaultID, fileID, s); err == nil {
		t.Error("truncated blob must fail")
	}
	// Reordering chunks.
	re := append([]byte(nil), blob...)
	copy(re[hdr:hdr+chunk], blob[hdr+chunk:hdr+2*chunk])
	copy(re[hdr+chunk:hdr+2*chunk], blob[hdr:hdr+chunk])
	if err := dec(re, vaultID, fileID, s); err == nil {
		t.Error("reordered chunks must fail")
	}
	otherFile := mustUUID("0194f0a8-5e1c-7b1d-9a3e-2b8f4e7c1a11")
	if err := dec(blob, vaultID, otherFile, s); err == nil {
		t.Error("blob moved to another file id must fail")
	}
	otherVault := mustUUID("0194f0a8-0000-7000-8000-00000000bbbb")
	if err := dec(blob, otherVault, fileID, s); err == nil {
		t.Error("blob moved to another vault must fail")
	}
	if err := dec(blob, vaultID, fileID, testSubkeys(t)); err == nil {
		t.Error("wrong key must fail")
	}
	if !errors.Is(dec([]byte("NDS2xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"), vaultID, fileID, s), vaultcrypto.ErrFormat) {
		t.Error("bad magic must be a format error")
	}
	if !errors.Is(dec(nil, vaultID, fileID, s), vaultcrypto.ErrFormat) {
		t.Error("empty input must be a format error")
	}
	if err := dec(append(append([]byte(nil), blob...), 1, 2, 3), vaultID, fileID, s); err == nil {
		t.Error("trailing garbage must fail")
	}
}

func TestBlobHasNewKeyPerEncryption(t *testing.T) {
	s := testSubkeys(t)
	a, _ := vaultcrypto.Encrypt(s, vaultID, fileID, []byte("same"))
	b, _ := vaultcrypto.Encrypt(s, vaultID, fileID, []byte("same"))
	if bytes.Equal(a, b) {
		t.Error("two encryptions of the same content must differ (fresh salt)")
	}
}

func TestEnvelopeFlow(t *testing.T) {
	vmk, _ := vaultcrypto.GenerateVMK()
	p := vaultcrypto.NewPassphraseKDF(0, 0, 0) // raised to the minimum
	if p.T != vaultcrypto.MinT || p.MKiB != vaultcrypto.MinMKiB || p.P != vaultcrypto.MinP {
		t.Fatalf("params not at minimum: %+v", p)
	}
	kek, err := vaultcrypto.DeriveKEKPassphrase("correct horse battery staple", p)
	if err != nil {
		t.Fatal(err)
	}
	wrapped, err := vaultcrypto.Wrap(kek, vmk)
	if err != nil {
		t.Fatal(err)
	}
	got, err := vaultcrypto.Unwrap(kek, wrapped, vaultID, vaultcrypto.KindPassphrase)
	if err != nil || got != vmk {
		t.Fatalf("unwrap: %v", err)
	}
	bad, _ := vaultcrypto.DeriveKEKPassphrase("wrong passphrase!!", p)
	if _, err := vaultcrypto.Unwrap(bad, wrapped, vaultID, vaultcrypto.KindPassphrase); !errors.Is(err, vaultcrypto.ErrDecrypt) {
		t.Errorf("wrong passphrase: %v", err)
	}
	if _, err := vaultcrypto.Unwrap(kek, wrapped[:10], vaultID, vaultcrypto.KindPassphrase); !errors.Is(err, vaultcrypto.ErrDecrypt) {
		t.Errorf("short envelope: %v", err)
	}

	rk, _ := vaultcrypto.GenerateRecoveryKey()
	rp := vaultcrypto.NewRecoveryKDF()
	rkek, _ := vaultcrypto.DeriveKEKRecovery(rk, rp)
	rw, _ := vaultcrypto.WrapV2(rkek, vmk, vaultID, vaultcrypto.KindRecovery)
	parsed, err := vaultcrypto.ParseRecoveryKey(strings.ToLower(rk.String()))
	if err != nil || parsed != rk {
		t.Fatalf("recovery parse: %v", err)
	}
	pk, _ := vaultcrypto.DeriveKEKRecovery(parsed, rp)
	if v, err := vaultcrypto.Unwrap(pk, rw, vaultID, vaultcrypto.KindRecovery); err != nil || v != vmk {
		t.Fatalf("recovery unwrap: %v", err)
	}
	if _, err := vaultcrypto.Unwrap(pk, rw, vaultID, vaultcrypto.KindPassphrase); !errors.Is(err, vaultcrypto.ErrDecrypt) {
		t.Errorf("v2 recovery envelope opened as a passphrase envelope: %v", err)
	}
}

func TestEnvelopeV2(t *testing.T) {
	vmk, _ := vaultcrypto.GenerateVMK()
	var kek [vaultcrypto.KeySize]byte
	_, _ = rand.Read(kek[:])
	w, err := vaultcrypto.WrapV2(kek, vmk, vaultID, vaultcrypto.KindPassphrase)
	if err != nil || len(w) != vaultcrypto.WrappedSizeV2 || w[0] != vaultcrypto.EnvelopeV2 {
		t.Fatalf("v2 envelope: %d bytes, %v", len(w), err)
	}
	if vaultcrypto.EnvelopeVersion(w) != 2 {
		t.Fatal("version not detected")
	}
	if got, err := vaultcrypto.Unwrap(kek, w, vaultID, vaultcrypto.KindPassphrase); err != nil || got != vmk {
		t.Fatalf("unwrap v2: %v", err)
	}
	if _, err := vaultcrypto.WrapV2(kek, vmk, vaultID, "backup"); err == nil {
		t.Error("unknown kind accepted by the writer")
	}
	if _, err := vaultcrypto.Unwrap(kek, w, vaultID, "backup"); !errors.Is(err, vaultcrypto.ErrDecrypt) {
		t.Errorf("unknown kind: %v", err)
	}
	// Two encryptions of the same VMK never repeat (random nonce).
	w2, _ := vaultcrypto.WrapV2(kek, vmk, vaultID, vaultcrypto.KindPassphrase)
	if bytes.Equal(w, w2) {
		t.Error("v2 envelopes must differ")
	}
}

func TestPassphraseNormalization(t *testing.T) {
	const nfc, nfd = "caf\u00e9 cr\u00e8me br\u00fbl\u00e9e", "cafe\u0301 cre\u0300me bru\u0302le\u0301e"
	if forms := vaultcrypto.PassphraseForms(nfd); len(forms) != 2 || forms[0] != nfc || forms[1] != nfd {
		t.Fatalf("forms of NFD input: %q", forms)
	}
	if forms := vaultcrypto.PassphraseForms(nfc); len(forms) != 2 || forms[0] != nfc || forms[1] != nfd {
		t.Fatalf("forms of NFC input: %q", forms)
	}
	if forms := vaultcrypto.PassphraseForms("plain ascii"); len(forms) != 1 {
		t.Fatalf("ASCII input needs one form: %q", forms)
	}
	p := vaultcrypto.NewPassphraseKDF(0, 0, 0)
	a, _ := vaultcrypto.DeriveKEKPassphrase(nfc, p)
	b, _ := vaultcrypto.DeriveKEKPassphrase(nfd, p)
	if a != b {
		t.Fatal("NFC and NFD input must derive the same KEK")
	}
	vmk, _ := vaultcrypto.GenerateVMK()
	// A legacy envelope, wrapped under the raw bytes of a decomposed input,
	// still opens with either form; the result says so and carries the NFC KEK.
	raw, _ := vaultcrypto.DeriveKEKPassphraseRaw(nfd, p)
	legacy, _ := vaultcrypto.Wrap(raw, vmk)
	for _, typed := range []string{nfd, nfc} {
		res, err := vaultcrypto.OpenWithPassphrase(typed, p, legacy, vaultID)
		if err != nil || res.VMK != vmk || !res.Legacy || res.KEK != a || res.Version != 1 {
			t.Fatalf("legacy envelope with %q: legacy=%v err=%v", typed, res.Legacy, err)
		}
	}
	current, _ := vaultcrypto.WrapV2(a, vmk, vaultID, vaultcrypto.KindPassphrase)
	res, err := vaultcrypto.OpenWithPassphrase(nfd, p, current, vaultID)
	if err != nil || res.VMK != vmk || res.Legacy || res.Version != 2 {
		t.Fatalf("current envelope: %+v %v", res.Legacy, err)
	}
	if _, err := vaultcrypto.OpenWithPassphrase("cafe creme brulee", p, current, vaultID); !errors.Is(err, vaultcrypto.ErrDecrypt) {
		t.Errorf("wrong passphrase: %v", err)
	}
	weak := p
	weak.MKiB = 1024
	if _, err := vaultcrypto.OpenWithPassphrase(nfc, weak, current, vaultID); !errors.Is(err, vaultcrypto.ErrWeakKDF) {
		t.Errorf("weak KDF: %v", err)
	}
}

func TestKDFParametersAreBounded(t *testing.T) {
	salt := base64.StdEncoding.EncodeToString(make([]byte, 16))
	for name, p := range map[string]vaultcrypto.KDFParams{
		"low t":     {Alg: "argon2id", T: 1, MKiB: 65536, P: 4, Salt: salt},
		"low m":     {Alg: "argon2id", T: 3, MKiB: 1024, P: 4, Salt: salt},
		"low p":     {Alg: "argon2id", T: 3, MKiB: 65536, P: 1, Salt: salt},
		"huge m":    {Alg: "argon2id", T: 3, MKiB: 1 << 30, P: 4, Salt: salt},
		"wrong alg": {Alg: "pbkdf2", T: 3, MKiB: 65536, P: 4, Salt: salt},
		"bad salt":  {Alg: "argon2id", T: 3, MKiB: 65536, P: 4, Salt: "!!"},
	} {
		if _, err := vaultcrypto.DeriveKEKPassphrase("passphrase-long-enough", p); !errors.Is(err, vaultcrypto.ErrWeakKDF) {
			t.Errorf("%s: err = %v, want ErrWeakKDF", name, err)
		}
	}
}

func TestRecoveryKeyDetectsTypos(t *testing.T) {
	rk, _ := vaultcrypto.GenerateRecoveryKey()
	s := rk.String()
	if len(strings.ReplaceAll(s, "-", "")) != 55 || strings.Count(s, "-") != 10 {
		t.Fatalf("unexpected format %q", s)
	}
	b := []byte(s)
	if b[0] == 'A' {
		b[0] = 'B'
	} else {
		b[0] = 'A'
	}
	if _, err := vaultcrypto.ParseRecoveryKey(string(b)); !errors.Is(err, vaultcrypto.ErrRecoveryKey) {
		t.Errorf("typo not detected: %v", err)
	}
	if _, err := vaultcrypto.ParseRecoveryKey("short"); !errors.Is(err, vaultcrypto.ErrRecoveryKey) {
		t.Errorf("short key accepted: %v", err)
	}
}

func TestPaths(t *testing.T) {
	s := testSubkeys(t)
	tok, err := vaultcrypto.EncryptPath(s, vaultID, "Projects/Alfa/riunione.md")
	if err != nil || !strings.HasPrefix(tok, "enc1:") {
		t.Fatalf("encrypt: %v %q", err, tok)
	}
	if strings.Contains(tok, "Alfa") {
		t.Error("token leaks the path")
	}
	got, err := vaultcrypto.DecryptPath(s, vaultID, tok)
	if err != nil || got != "Projects/Alfa/riunione.md" {
		t.Fatalf("decrypt: %v %q", err, got)
	}
	if _, err := vaultcrypto.DecryptPath(s, mustUUID("0194f0a8-0000-7000-8000-00000000bbbb"), tok); err == nil {
		t.Error("token bound to another vault must fail")
	}
	k1, _ := vaultcrypto.PathKey(s, "Notes/Straße.md")
	k2, _ := vaultcrypto.PathKey(s, "notes/STRASSE.md")
	k3, _ := vaultcrypto.PathKey(s, "notes/other.md")
	if k1 != k2 {
		t.Error("path keys must collide for case/NFC variants (PATH_COLLISION)")
	}
	if k1 == k3 || !strings.HasPrefix(k1, "hmac1:") {
		t.Errorf("path key wrong: %s %s", k1, k3)
	}
	if _, err := vaultcrypto.EncryptPath(s, vaultID, "bad:name.md"); err == nil {
		t.Error("invalid path must be rejected before encryption")
	}
}

// vectors mirrors shared/conformance/crypto/vectors.json.
type vectors struct {
	Passphrase struct {
		Passphrase string                `json:"passphrase"`
		KDF        vaultcrypto.KDFParams `json:"kdf"`
		KEK        string                `json:"kek"`
	} `json:"passphrase"`
	Recovery struct {
		Key     string                `json:"key_hex"`
		Encoded string                `json:"encoded"`
		KDF     vaultcrypto.KDFParams `json:"kdf"`
		KEK     string                `json:"kek"`
	} `json:"recovery"`
	Wrap struct {
		KEK     string `json:"kek"`
		VMK     string `json:"vmk"`
		Nonce   string `json:"nonce"`
		Wrapped string `json:"wrapped"`
	} `json:"wrap"`
	WrapV2               []wrapV2Vector       `json:"wrap_v2"`
	PassphraseNormalized passphraseNormVector `json:"passphrase_normalization"`
	Subkeys              struct {
		VMK     string `json:"vmk"`
		PathEnc string `json:"path_enc"`
		PathKey string `json:"path_key"`
		FileID  string `json:"file_id"`
		Salt    string `json:"salt"`
		File    string `json:"file"`
	} `json:"subkeys"`
	Blobs []blobVector `json:"blobs"`
	Paths []pathVector `json:"paths"`
}

type blobVector struct {
	Name         string `json:"name"`
	VaultID      string `json:"vault_id"`
	FileID       string `json:"file_id"`
	Salt         string `json:"salt"`
	ChunkSize    int    `json:"chunk_size"`
	PlaintextLen int    `json:"plaintext_len"` // plaintext is byte(i % 251)
	Blob         string `json:"blob,omitempty"`
	BlobSHA256   string `json:"blob_sha256"`
}

// wrapV2Vector is an ADR-0034 envelope: 0x02 ‖ nonce ‖ AES-256-GCM(KEK, VMK; AAD) ‖ tag.
type wrapV2Vector struct {
	KEK     string `json:"kek"`
	VMK     string `json:"vmk"`
	VaultID string `json:"vault_id"`
	Kind    string `json:"kind"`
	Nonce   string `json:"nonce"`
	AAD     string `json:"aad"`
	Wrapped string `json:"wrapped"`
}

// passphraseNormVector checks the NFC rule: both inputs derive KEK; KEKRawNFD
// is the pre-normalization derivation of the NFD bytes. Legacy is a v1
// envelope wrapped under KEKRawNFD, which both inputs must still open (through
// the raw/NFD fallback); Current is a v2 envelope wrapped under KEK.
type passphraseNormVector struct {
	NFC       string                `json:"nfc"`
	NFD       string                `json:"nfd"`
	KDF       vaultcrypto.KDFParams `json:"kdf"`
	KEK       string                `json:"kek"`
	KEKRawNFD string                `json:"kek_raw_nfd"`
	VaultID   string                `json:"vault_id"`
	VMK       string                `json:"vmk"`
	Legacy    string                `json:"legacy_wrapped"`
	Current   string                `json:"current_wrapped"`
}

type pathVector struct {
	VaultID string `json:"vault_id"`
	Path    string `json:"path"`
	Nonce   string `json:"nonce"`
	Enc     string `json:"enc"`
	Key     string `json:"key"`
}

const (
	vecVMK   = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
	vecKEK   = "a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf"
	vecRK    = "c0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf"
	vecVault = "0194f0a8-0000-7000-8000-00000000aaaa"
	vecFile  = "0194f0a8-5e1c-7b1d-9a3e-2b8f4e7c1a10"
)

func unhex(s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		panic(err)
	}
	return b
}

func arr32(s string) (a [32]byte) { copy(a[:], unhex(s)); return }

func pattern(n int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(i % 251)
	}
	return b
}

func blobFor(t *testing.T, sk vaultcrypto.Subkeys, v blobVector) []byte {
	t.Helper()
	var salt [16]byte
	copy(salt[:], unhex(v.Salt))
	var buf bytes.Buffer
	if err := vaultcrypto.EncryptBlobWith(&buf, bytes.NewReader(pattern(v.PlaintextLen)), sk, mustUUID(v.VaultID), mustUUID(v.FileID), salt, v.ChunkSize); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func generate(t *testing.T) vectors {
	var v vectors
	v.Passphrase.Passphrase = "correct horse battery staple"
	v.Passphrase.KDF = vaultcrypto.KDFParams{Alg: "argon2id", T: 3, MKiB: 65536, P: 4, Salt: base64.StdEncoding.EncodeToString(unhex("101112131415161718191a1b1c1d1e1f"))}
	kek, err := vaultcrypto.DeriveKEKPassphrase(v.Passphrase.Passphrase, v.Passphrase.KDF)
	if err != nil {
		t.Fatal(err)
	}
	v.Passphrase.KEK = hex.EncodeToString(kek[:])

	rk := vaultcrypto.RecoveryKey(arr32(vecRK))
	v.Recovery.Key = vecRK
	v.Recovery.Encoded = rk.String()
	v.Recovery.KDF = vaultcrypto.KDFParams{Alg: "hkdf-sha256", Salt: base64.StdEncoding.EncodeToString(unhex("202122232425262728292a2b2c2d2e2f"))}
	rkek, _ := vaultcrypto.DeriveKEKRecovery(rk, v.Recovery.KDF)
	v.Recovery.KEK = hex.EncodeToString(rkek[:])

	vmk := vaultcrypto.VMK(arr32(vecVMK))
	v.Wrap.KEK, v.Wrap.VMK, v.Wrap.Nonce = vecKEK, vecVMK, "303132333435363738393a3b"
	w, _ := vaultcrypto.WrapWithNonce(arr32(vecKEK), vmk, unhex(v.Wrap.Nonce))
	v.Wrap.Wrapped = hex.EncodeToString(w)
	for i, kind := range []vaultcrypto.EnvelopeKind{vaultcrypto.KindPassphrase, vaultcrypto.KindRecovery} {
		c := wrapV2Vector{KEK: vecKEK, VMK: vecVMK, VaultID: vecVault, Kind: string(kind), Nonce: hex.EncodeToString(bytes.Repeat([]byte{byte(0x70 + i)}, 12))}
		aad, _ := vaultcrypto.EnvelopeAAD(mustUUID(vecVault), kind)
		c.AAD = hex.EncodeToString(aad)
		w2, err := vaultcrypto.WrapV2WithNonce(arr32(vecKEK), vmk, mustUUID(vecVault), kind, unhex(c.Nonce))
		if err != nil {
			t.Fatal(err)
		}
		c.Wrapped = hex.EncodeToString(w2)
		v.WrapV2 = append(v.WrapV2, c)
	}

	pn := &v.PassphraseNormalized
	const accented = "P\u00e4ssw\u00f6rd f\u00fcr \u00c5ngstr\u00f6m: cr\u00e8me br\u00fbl\u00e9e"
	pn.NFC, pn.NFD = norm.NFC.String(accented), norm.NFD.String(accented)
	pn.KDF = vaultcrypto.KDFParams{Alg: "argon2id", T: 3, MKiB: 65536, P: 4, Salt: base64.StdEncoding.EncodeToString(unhex("808182838485868788898a8b8c8d8e8f"))}
	nk, err := vaultcrypto.DeriveKEKPassphrase(pn.NFC, pn.KDF)
	if err != nil {
		t.Fatal(err)
	}
	rk2, _ := vaultcrypto.DeriveKEKPassphraseRaw(pn.NFD, pn.KDF)
	pn.KEK, pn.KEKRawNFD = hex.EncodeToString(nk[:]), hex.EncodeToString(rk2[:])
	pn.VaultID, pn.VMK = vecVault, vecVMK
	lw, _ := vaultcrypto.WrapWithNonce(rk2, vmk, bytes.Repeat([]byte{0x90}, 12))
	cw, _ := vaultcrypto.WrapV2WithNonce(nk, vmk, mustUUID(vecVault), vaultcrypto.KindPassphrase, bytes.Repeat([]byte{0x91}, 12))
	pn.Legacy, pn.Current = hex.EncodeToString(lw), hex.EncodeToString(cw)

	sk := vaultcrypto.DeriveSubkeys(vmk)
	v.Subkeys.VMK = vecVMK
	v.Subkeys.PathEnc = hex.EncodeToString(sk.PathEnc[:])
	v.Subkeys.PathKey = hex.EncodeToString(sk.PathKey[:])
	v.Subkeys.FileID = vecFile
	v.Subkeys.Salt = "404142434445464748494a4b4c4d4e4f"
	var fs [16]byte
	copy(fs[:], unhex(v.Subkeys.Salt))
	fk := sk.FileKey(mustUUID(vecFile), fs)
	v.Subkeys.File = hex.EncodeToString(fk[:])

	for _, c := range []blobVector{
		{Name: "empty", PlaintextLen: 0, ChunkSize: 16},
		{Name: "one chunk (partial)", PlaintextLen: 10, ChunkSize: 16},
		{Name: "one chunk (exact)", PlaintextLen: 16, ChunkSize: 16},
		{Name: "two chunks", PlaintextLen: 20, ChunkSize: 16},
		{Name: "two chunks (exact)", PlaintextLen: 32, ChunkSize: 16},
		{Name: "default chunk size, two chunks", PlaintextLen: 65536 + 5, ChunkSize: 65536},
	} {
		c.VaultID, c.FileID, c.Salt = vecVault, vecFile, "505152535455565758595a5b5c5d5e5f"
		b := blobFor(t, sk, c)
		sum := sha256.Sum256(b)
		c.BlobSHA256 = hex.EncodeToString(sum[:])
		if len(b) <= 512 {
			c.Blob = hex.EncodeToString(b)
		}
		v.Blobs = append(v.Blobs, c)
	}
	for i, p := range []string{"Projects/Alfa/riunione.md", "Notes/Straße.md", "a.md"} {
		nonce := hex.EncodeToString(bytes.Repeat([]byte{byte(0x60 + i)}, 12))
		enc, _ := vaultcrypto.EncryptPathWithNonce(sk, mustUUID(vecVault), p, unhex(nonce))
		key, _ := vaultcrypto.PathKey(sk, p)
		v.Paths = append(v.Paths, pathVector{VaultID: vecVault, Path: p, Nonce: nonce, Enc: enc, Key: key})
	}
	return v
}

func TestVectors(t *testing.T) {
	file := filepath.Join("..", "..", "conformance", "crypto", "vectors.json")
	if os.Getenv("UPDATE_VECTORS") != "" {
		b, err := json.MarshalIndent(generate(t), "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, append(b, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatalf("%v (generate with UPDATE_VECTORS=1)", err)
	}
	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}

	kek, err := vaultcrypto.DeriveKEKPassphrase(v.Passphrase.Passphrase, v.Passphrase.KDF)
	if err != nil || hex.EncodeToString(kek[:]) != v.Passphrase.KEK {
		t.Errorf("passphrase KEK mismatch (%v)", err)
	}
	rk := vaultcrypto.RecoveryKey(arr32(v.Recovery.Key))
	if rk.String() != v.Recovery.Encoded {
		t.Errorf("recovery encoding %q, want %q", rk.String(), v.Recovery.Encoded)
	}
	if parsed, err := vaultcrypto.ParseRecoveryKey(v.Recovery.Encoded); err != nil || parsed != rk {
		t.Errorf("recovery parse: %v", err)
	}
	rkek, _ := vaultcrypto.DeriveKEKRecovery(rk, v.Recovery.KDF)
	if hex.EncodeToString(rkek[:]) != v.Recovery.KEK {
		t.Error("recovery KEK mismatch")
	}
	vmk := vaultcrypto.VMK(arr32(v.Wrap.VMK))
	w, _ := vaultcrypto.WrapWithNonce(arr32(v.Wrap.KEK), vmk, unhex(v.Wrap.Nonce))
	if hex.EncodeToString(w) != v.Wrap.Wrapped {
		t.Error("wrap mismatch")
	}
	if got, err := vaultcrypto.Unwrap(arr32(v.Wrap.KEK), unhex(v.Wrap.Wrapped), mustUUID(vecVault), vaultcrypto.KindPassphrase); err != nil || got != vmk {
		t.Errorf("unwrap vector: %v", err)
	}
	if len(v.WrapV2) != 2 {
		t.Fatal("wrap_v2 vectors missing")
	}
	for _, c := range v.WrapV2 {
		kind, vid := vaultcrypto.EnvelopeKind(c.Kind), mustUUID(c.VaultID)
		aad, err := vaultcrypto.EnvelopeAAD(vid, kind)
		if err != nil || hex.EncodeToString(aad) != c.AAD {
			t.Errorf("wrap_v2 %s: AAD mismatch (%v)", c.Kind, err)
		}
		w, err := vaultcrypto.WrapV2WithNonce(arr32(c.KEK), vaultcrypto.VMK(arr32(c.VMK)), vid, kind, unhex(c.Nonce))
		if err != nil || hex.EncodeToString(w) != c.Wrapped {
			t.Errorf("wrap_v2 %s: mismatch (%v)", c.Kind, err)
		}
		if got, err := vaultcrypto.Unwrap(arr32(c.KEK), unhex(c.Wrapped), vid, kind); err != nil || got != vaultcrypto.VMK(arr32(c.VMK)) {
			t.Errorf("wrap_v2 %s: unwrap: %v", c.Kind, err)
		}
	}
	pn := v.PassphraseNormalized
	if pn.NFC == pn.NFD || norm.NFC.String(pn.NFD) != pn.NFC {
		t.Fatal("passphrase_normalization: inputs are not two forms of one string")
	}
	for _, in := range []string{pn.NFC, pn.NFD} {
		if k, err := vaultcrypto.DeriveKEKPassphrase(in, pn.KDF); err != nil || hex.EncodeToString(k[:]) != pn.KEK {
			t.Errorf("passphrase_normalization: KEK of %+q mismatch (%v)", in, err)
		}
	}
	if k, _ := vaultcrypto.DeriveKEKPassphraseRaw(pn.NFD, pn.KDF); hex.EncodeToString(k[:]) != pn.KEKRawNFD || pn.KEKRawNFD == pn.KEK {
		t.Error("passphrase_normalization: raw NFD KEK mismatch")
	}
	for _, in := range []string{pn.NFC, pn.NFD} {
		res, err := vaultcrypto.OpenWithPassphrase(in, pn.KDF, unhex(pn.Legacy), mustUUID(pn.VaultID))
		if err != nil || hex.EncodeToString(res.VMK[:]) != pn.VMK || !res.Legacy || hex.EncodeToString(res.KEK[:]) != pn.KEK {
			t.Errorf("passphrase_normalization: legacy envelope with %+q: legacy=%v %v", in, res.Legacy, err)
		}
		res, err = vaultcrypto.OpenWithPassphrase(in, pn.KDF, unhex(pn.Current), mustUUID(pn.VaultID))
		if err != nil || hex.EncodeToString(res.VMK[:]) != pn.VMK || res.Legacy || res.Version != 2 {
			t.Errorf("passphrase_normalization: current envelope with %+q: %v", in, err)
		}
	}
	sk := vaultcrypto.DeriveSubkeys(vaultcrypto.VMK(arr32(v.Subkeys.VMK)))
	if hex.EncodeToString(sk.PathEnc[:]) != v.Subkeys.PathEnc || hex.EncodeToString(sk.PathKey[:]) != v.Subkeys.PathKey {
		t.Error("path subkeys mismatch")
	}
	var fs [16]byte
	copy(fs[:], unhex(v.Subkeys.Salt))
	fk := sk.FileKey(mustUUID(v.Subkeys.FileID), fs)
	if hex.EncodeToString(fk[:]) != v.Subkeys.File {
		t.Error("file key mismatch")
	}
	for _, b := range v.Blobs {
		got := blobFor(t, sk, b)
		sum := sha256.Sum256(got)
		if hex.EncodeToString(sum[:]) != b.BlobSHA256 {
			t.Errorf("blob %q: hash mismatch", b.Name)
		}
		if b.Blob != "" && hex.EncodeToString(got) != b.Blob {
			t.Errorf("blob %q: bytes mismatch", b.Name)
		}
		var out bytes.Buffer
		if err := vaultcrypto.DecryptBlob(&out, bytes.NewReader(got), sk, mustUUID(b.VaultID), mustUUID(b.FileID)); err != nil || !bytes.Equal(out.Bytes(), pattern(b.PlaintextLen)) {
			t.Errorf("blob %q: decrypt: %v", b.Name, err)
		}
	}
	for _, p := range v.Paths {
		enc, err := vaultcrypto.EncryptPathWithNonce(sk, mustUUID(p.VaultID), p.Path, unhex(p.Nonce))
		if err != nil || enc != p.Enc {
			t.Errorf("path %q: enc mismatch (%v)", p.Path, err)
		}
		if got, err := vaultcrypto.DecryptPath(sk, mustUUID(p.VaultID), p.Enc); err != nil || got != p.Path {
			t.Errorf("path %q: decrypt %q %v", p.Path, got, err)
		}
		if key, _ := vaultcrypto.PathKey(sk, p.Path); key != p.Key {
			t.Errorf("path %q: key mismatch", p.Path)
		}
	}
}
