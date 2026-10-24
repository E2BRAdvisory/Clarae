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

	"nodus/shared/vaultcrypto"
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
	got, err := vaultcrypto.Unwrap(kek, wrapped)
	if err != nil || got != vmk {
		t.Fatalf("unwrap: %v", err)
	}
	bad, _ := vaultcrypto.DeriveKEKPassphrase("wrong passphrase!!", p)
	if _, err := vaultcrypto.Unwrap(bad, wrapped); !errors.Is(err, vaultcrypto.ErrDecrypt) {
		t.Errorf("wrong passphrase: %v", err)
	}
	if _, err := vaultcrypto.Unwrap(kek, wrapped[:10]); !errors.Is(err, vaultcrypto.ErrDecrypt) {
		t.Errorf("short envelope: %v", err)
	}

	rk, _ := vaultcrypto.GenerateRecoveryKey()
	rp := vaultcrypto.NewRecoveryKDF()
	rkek, _ := vaultcrypto.DeriveKEKRecovery(rk, rp)
	rw, _ := vaultcrypto.Wrap(rkek, vmk)
	parsed, err := vaultcrypto.ParseRecoveryKey(strings.ToLower(rk.String()))
	if err != nil || parsed != rk {
		t.Fatalf("recovery parse: %v", err)
	}
	pk, _ := vaultcrypto.DeriveKEKRecovery(parsed, rp)
	if v, err := vaultcrypto.Unwrap(pk, rw); err != nil || v != vmk {
		t.Fatalf("recovery unwrap: %v", err)
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
	Subkeys struct {
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
	if got, err := vaultcrypto.Unwrap(arr32(v.Wrap.KEK), unhex(v.Wrap.Wrapped)); err != nil || got != vmk {
		t.Errorf("unwrap vector: %v", err)
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
