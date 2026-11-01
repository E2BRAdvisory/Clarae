package vaultcrypto_test

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"memobrain/shared/vaultcrypto"
)

// Negative vectors: inputs that every implementation (Go and TypeScript) must
// reject. They live in shared/conformance/crypto/negative-vectors.json; the Go
// side generates them (UPDATE_VECTORS=1) and both sides verify them.
//
// "expect" is the error class: "decrypt" (authentication failed), "format"
// (not an NDS1 blob / malformed token) or "any" when both implementations
// reject the input but classify it differently (e.g. trailing bytes shorter
// than a GCM tag are a format error in TS but surface as an authentication
// failure in Go, which authenticates the previous chunk first).

type negBlob struct {
	Name    string `json:"name"`
	VaultID string `json:"vault_id"`
	FileID  string `json:"file_id"`
	VMK     string `json:"vmk"`
	Blob    string `json:"blob"`
	Expect  string `json:"expect"`
}

type negPath struct {
	Name    string `json:"name"`
	VaultID string `json:"vault_id"`
	Token   string `json:"token"`
	Expect  string `json:"expect"`
}

// negWrap is opened as the envelope of VaultID and Kind (defaults: the
// vector vault and "passphrase").
type negWrap struct {
	Name    string `json:"name"`
	KEK     string `json:"kek"`
	Wrapped string `json:"wrapped"`
	VaultID string `json:"vault_id,omitempty"`
	Kind    string `json:"kind,omitempty"`
	Expect  string `json:"expect"`
}

type negKDF struct {
	Name string                `json:"name"`
	KDF  vaultcrypto.KDFParams `json:"kdf"`
}

type negRecovery struct {
	Name string `json:"name"`
	Text string `json:"text"`
}

type negVectors struct {
	Blobs    []negBlob     `json:"blobs"`
	Paths    []negPath     `json:"paths"`
	Wrap     []negWrap     `json:"wrap"`
	KDF      []negKDF      `json:"kdf"`
	Recovery []negRecovery `json:"recovery"`
}

const (
	negHdr   = 25 // magic 4 + version 1 + salt 16 + chunk size 4
	negChunk = 16 + vaultcrypto.TagSize
)

const (
	negOtherVault = "0194f0a8-0000-7000-8000-00000000bbbb"
	negOtherFile  = "0194f0a8-5e1c-7b1d-9a3e-2b8f4e7c1a11"
)

func generateNegative(t *testing.T) negVectors {
	t.Helper()
	sk := vaultcrypto.DeriveSubkeys(vaultcrypto.VMK(arr32(vecVMK)))
	base := blobFor(t, sk, blobVector{VaultID: vecVault, FileID: vecFile, Salt: "505152535455565758595a5b5c5d5e5f", ChunkSize: 16, PlaintextLen: 40})
	if len(base) != negHdr+2*negChunk+8+vaultcrypto.TagSize {
		t.Fatalf("unexpected base blob size %d", len(base))
	}
	cp := func() []byte { return append([]byte(nil), base...) }
	chunk := func(i int) []byte { return base[negHdr+i*negChunk : min(negHdr+(i+1)*negChunk, len(base))] }
	cat := func(parts ...[]byte) []byte { return bytes.Join(parts, nil) }
	hdr := base[:negHdr]

	var v negVectors
	add := func(name string, blob []byte, expect string) {
		v.Blobs = append(v.Blobs, negBlob{Name: name, VaultID: vecVault, FileID: vecFile, VMK: vecVMK, Blob: hex.EncodeToString(blob), Expect: expect})
	}
	flip := func(i int) []byte { b := cp(); b[i] ^= 1; return b }

	add("tampered tag of first chunk", flip(negHdr+negChunk-1), "decrypt")
	add("tampered tag of last chunk", flip(len(base)-1), "decrypt")
	add("tampered ciphertext", flip(negHdr+3), "decrypt")
	add("tampered salt in header", flip(6), "decrypt")
	cs := cp()
	binary.BigEndian.PutUint32(cs[negHdr-4:], 32)
	add("chunk size field changed", cs, "decrypt")
	add("last chunk dropped (truncation at chunk boundary)", base[:negHdr+2*negChunk], "decrypt")
	add("first chunk dropped", cat(hdr, chunk(1), chunk(2)), "decrypt")
	add("truncated inside a chunk tag", base[:len(base)-10], "any")
	add("header only", hdr, "format")
	add("truncated header", base[:10], "format")
	add("empty input", nil, "format")
	add("chunks 0 and 1 swapped", cat(hdr, chunk(1), chunk(0), chunk(2)), "decrypt")
	add("last chunk swapped with middle chunk", cat(hdr, chunk(0), chunk(2), chunk(1)), "decrypt")
	add("chunk duplicated", cat(hdr, chunk(0), chunk(1), chunk(1), chunk(2)), "decrypt")
	add("chunk appended after last", cat(base, chunk(1)), "decrypt")
	add("trailing garbage shorter than a tag", cat(base, []byte{1, 2, 3}), "any")
	bm := cp()
	copy(bm, "NDS2")
	add("bad magic", bm, "format")
	bv := cp()
	bv[4] = 2
	add("unsupported version", bv, "format")
	cz := cp()
	binary.BigEndian.PutUint32(cz[negHdr-4:], 0)
	add("chunk size zero", cz, "format")
	co := cp()
	binary.BigEndian.PutUint32(co[negHdr-4:], 16*1024*1024+1)
	add("chunk size above maximum", co, "format")
	v.Blobs = append(v.Blobs,
		negBlob{Name: "wrong vault id in AAD", VaultID: negOtherVault, FileID: vecFile, VMK: vecVMK, Blob: hex.EncodeToString(base), Expect: "decrypt"},
		negBlob{Name: "wrong file id in AAD and key", VaultID: vecVault, FileID: negOtherFile, VMK: vecVMK, Blob: hex.EncodeToString(base), Expect: "decrypt"},
		negBlob{Name: "wrong vault master key", VaultID: vecVault, FileID: vecFile, VMK: strings.Repeat("ab", 32), Blob: hex.EncodeToString(base), Expect: "decrypt"},
	)

	tok, err := vaultcrypto.EncryptPathWithNonce(sk, mustUUID(vecVault), "Projects/Alfa/riunione.md", bytes.Repeat([]byte{0x60}, 12))
	if err != nil {
		t.Fatal(err)
	}
	swap := func(c byte) byte {
		if c == 'A' {
			return 'B'
		}
		return 'A'
	}
	mid := len(tok) / 2
	tampered := tok[:mid] + string(swap(tok[mid])) + tok[mid+1:]
	v.Paths = []negPath{
		{"tampered token", vecVault, tampered, "decrypt"},
		{"token bound to another vault (AAD)", negOtherVault, tok, "decrypt"},
		{"wrong prefix", vecVault, "enc2:" + strings.TrimPrefix(tok, "enc1:"), "format"},
		{"deterministic key used as token", vecVault, "hmac1:" + strings.Repeat("00", 32), "format"},
		{"truncated below nonce and tag", vecVault, "enc1:AAAA", "format"},
		{"not base64url", vecVault, "enc1:!!!!", "format"},
	}

	w, _ := vaultcrypto.WrapWithNonce(arr32(vecKEK), vaultcrypto.VMK(arr32(vecVMK)), unhex("303132333435363738393a3b"))
	wf := append([]byte(nil), w...)
	wf[20] ^= 1
	wn := append([]byte(nil), w...)
	wn[0] ^= 1
	v.Wrap = []negWrap{
		{Name: "tampered wrapped key", KEK: vecKEK, Wrapped: hex.EncodeToString(wf), Expect: "decrypt"},
		{Name: "tampered nonce", KEK: vecKEK, Wrapped: hex.EncodeToString(wn), Expect: "decrypt"},
		{Name: "wrong KEK", KEK: strings.Repeat("cd", 32), Wrapped: hex.EncodeToString(w), Expect: "decrypt"},
		{Name: "wrong length", KEK: vecKEK, Wrapped: hex.EncodeToString(w[:len(w)-1]), Expect: "decrypt"},
		{Name: "empty", KEK: vecKEK, Wrapped: "", Expect: "decrypt"},
	}
	// ADR-0034 v2 envelopes: bound to the vault and the kind, no downgrade.
	v2, err := vaultcrypto.WrapV2WithNonce(arr32(vecKEK), vaultcrypto.VMK(arr32(vecVMK)), mustUUID(vecVault), vaultcrypto.KindPassphrase, bytes.Repeat([]byte{0x70}, 12))
	if err != nil {
		t.Fatal(err)
	}
	v2ver := append([]byte(nil), v2...)
	v2ver[0] = 0x03
	v2one := append([]byte(nil), v2...)
	v2one[0] = 0x01
	v2tag := append([]byte(nil), v2...)
	v2tag[len(v2tag)-1] ^= 1
	v.Wrap = append(v.Wrap,
		negWrap{Name: "v2 opened for another vault id", KEK: vecKEK, Wrapped: hex.EncodeToString(v2), VaultID: negOtherVault, Expect: "decrypt"},
		negWrap{Name: "v2 passphrase envelope opened as recovery (kind swapped)", KEK: vecKEK, Wrapped: hex.EncodeToString(v2), Kind: "recovery", Expect: "decrypt"},
		negWrap{Name: "v2 opened with an unknown kind", KEK: vecKEK, Wrapped: hex.EncodeToString(v2), Kind: "backup", Expect: "decrypt"},
		negWrap{Name: "v2 version byte altered (0x03)", KEK: vecKEK, Wrapped: hex.EncodeToString(v2ver), Expect: "decrypt"},
		negWrap{Name: "v2 version byte altered (0x01)", KEK: vecKEK, Wrapped: hex.EncodeToString(v2one), Expect: "decrypt"},
		negWrap{Name: "v2 truncated to 60 bytes (downgrade to v1)", KEK: vecKEK, Wrapped: hex.EncodeToString(v2[:vaultcrypto.WrappedSizeV1]), Expect: "decrypt"},
		negWrap{Name: "v2 without its version byte (downgrade to v1)", KEK: vecKEK, Wrapped: hex.EncodeToString(v2[1:]), Expect: "decrypt"},
		negWrap{Name: "v2 tampered tag", KEK: vecKEK, Wrapped: hex.EncodeToString(v2tag), Expect: "decrypt"},
		negWrap{Name: "v2 with a trailing byte", KEK: vecKEK, Wrapped: hex.EncodeToString(append(append([]byte(nil), v2...), 0)), Expect: "decrypt"},
	)

	salt := base64.StdEncoding.EncodeToString(unhex("101112131415161718191a1b1c1d1e1f"))
	ok := vaultcrypto.KDFParams{Alg: "argon2id", T: 3, MKiB: 65536, P: 4, Salt: salt}
	mk := func(name string, f func(*vaultcrypto.KDFParams)) negKDF {
		k := ok
		f(&k)
		return negKDF{Name: name, KDF: k}
	}
	v.KDF = []negKDF{
		mk("iterations below minimum", func(k *vaultcrypto.KDFParams) { k.T = 2 }),
		mk("memory below minimum", func(k *vaultcrypto.KDFParams) { k.MKiB = 32 * 1024 }),
		mk("parallelism below minimum", func(k *vaultcrypto.KDFParams) { k.P = 3 }),
		mk("iterations above maximum", func(k *vaultcrypto.KDFParams) { k.T = 13 }),
		mk("memory above maximum", func(k *vaultcrypto.KDFParams) { k.MKiB = 1024*1024 + 1 }),
		mk("parallelism above maximum", func(k *vaultcrypto.KDFParams) { k.P = 17 }),
		mk("zero parameters", func(k *vaultcrypto.KDFParams) { k.T, k.MKiB, k.P = 0, 0, 0 }),
		mk("other algorithm", func(k *vaultcrypto.KDFParams) { k.Alg = "argon2i" }),
		mk("salt shorter than 8 bytes", func(k *vaultcrypto.KDFParams) { k.Salt = base64.StdEncoding.EncodeToString([]byte{1, 2, 3, 4}) }),
		mk("salt not base64", func(k *vaultcrypto.KDFParams) { k.Salt = "***" }),
	}

	rk := vaultcrypto.RecoveryKey(arr32(vecRK)).String()
	v.Recovery = []negRecovery{
		{"typo in first character", string(swap(rk[0])) + rk[1:]},
		{"checksum group truncated", rk[:len(rk)-6]},
		{"too short", "AAAAA-BBBBB"},
		{"characters outside the alphabet", "1" + rk[1:]},
		{"empty", ""},
	}
	return v
}

func TestNegativeVectors(t *testing.T) {
	file := filepath.Join("..", "..", "conformance", "crypto", "negative-vectors.json")
	if os.Getenv("UPDATE_VECTORS") != "" {
		b, err := json.MarshalIndent(generateNegative(t), "", "  ")
		if err != nil {
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
	var v negVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.Blobs) < 20 || len(v.Paths) == 0 || len(v.Wrap) == 0 || len(v.KDF) == 0 || len(v.Recovery) == 0 {
		t.Fatal("negative vectors file is incomplete")
	}
	classify := func(t *testing.T, err error, expect string) {
		t.Helper()
		switch {
		case err == nil:
			t.Error("accepted, must be rejected")
		case expect == "any":
		case expect == "decrypt" && !errors.Is(err, vaultcrypto.ErrDecrypt):
			t.Errorf("got %v, want decrypt error", err)
		case expect == "format" && !errors.Is(err, vaultcrypto.ErrFormat):
			t.Errorf("got %v, want format error", err)
		}
	}
	for _, c := range v.Blobs {
		t.Run("blob/"+c.Name, func(t *testing.T) {
			s := vaultcrypto.DeriveSubkeys(vaultcrypto.VMK(arr32(c.VMK)))
			var out bytes.Buffer
			classify(t, vaultcrypto.DecryptBlob(&out, bytes.NewReader(unhex(c.Blob)), s, mustUUID(c.VaultID), mustUUID(c.FileID)), c.Expect)
		})
	}
	s := vaultcrypto.DeriveSubkeys(vaultcrypto.VMK(arr32(vecVMK)))
	for _, c := range v.Paths {
		t.Run("path/"+c.Name, func(t *testing.T) {
			_, err := vaultcrypto.DecryptPath(s, mustUUID(c.VaultID), c.Token)
			classify(t, err, c.Expect)
		})
	}
	for _, c := range v.Wrap {
		t.Run("wrap/"+c.Name, func(t *testing.T) {
			vid, kind := vecVault, vaultcrypto.KindPassphrase
			if c.VaultID != "" {
				vid = c.VaultID
			}
			if c.Kind != "" {
				kind = vaultcrypto.EnvelopeKind(c.Kind)
			}
			_, err := vaultcrypto.Unwrap(arr32(c.KEK), unhex(c.Wrapped), mustUUID(vid), kind)
			classify(t, err, c.Expect)
		})
	}
	for _, c := range v.KDF {
		t.Run("kdf/"+c.Name, func(t *testing.T) {
			if _, err := vaultcrypto.DeriveKEKPassphrase("passphrase", c.KDF); !errors.Is(err, vaultcrypto.ErrWeakKDF) {
				t.Errorf("got %v, want ErrWeakKDF", err)
			}
		})
	}
	for _, c := range v.Recovery {
		t.Run("recovery/"+c.Name, func(t *testing.T) {
			if _, err := vaultcrypto.ParseRecoveryKey(c.Text); !errors.Is(err, vaultcrypto.ErrRecoveryKey) {
				t.Errorf("got %v, want ErrRecoveryKey", err)
			}
		})
	}
}
