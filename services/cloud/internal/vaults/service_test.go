package vaults

import (
	"bytes"
	"encoding/base64"
	"testing"
)

func envelope(kind string, kdf KDF, size int) EnvelopeInput {
	return EnvelopeInput{Kind: kind, KDF: kdf, WrappedVMK: bytes.Repeat([]byte{1}, size)}
}

func TestValidateEnvelope(t *testing.T) {
	salt := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 16))
	argon := KDF{Alg: "argon2id", T: 3, MKiB: 65536, P: 4, Salt: salt}
	hkdf := KDF{Alg: "hkdf-sha256", Salt: salt}
	v2 := func(kind string, kdf KDF) EnvelopeInput {
		e := envelope(kind, kdf, WrappedVMKSizeV2)
		e.WrappedVMK[0] = 0x02
		return e
	}
	ok := []EnvelopeInput{
		envelope("passphrase", argon, WrappedVMKSize), envelope("recovery", hkdf, WrappedVMKSize),
		v2("passphrase", argon), v2("recovery", hkdf),
	}
	for _, e := range ok {
		if err := ValidateEnvelope(e); err != nil {
			t.Errorf("%s: %v", e.Kind, err)
		}
	}
	weak := argon
	weak.MKiB = 1024
	huge := argon
	huge.MKiB = 1 << 30
	for name, e := range map[string]EnvelopeInput{
		"weak memory":     envelope("passphrase", weak, WrappedVMKSize),
		"absurd memory":   envelope("passphrase", huge, WrappedVMKSize),
		"wrong alg":       envelope("passphrase", hkdf, WrappedVMKSize),
		"recovery argon":  envelope("recovery", argon, WrappedVMKSize),
		"short key":       envelope("passphrase", argon, 10),
		"59 bytes":        envelope("passphrase", argon, WrappedVMKSize-1),
		"61 bytes not v2": envelope("passphrase", argon, WrappedVMKSizeV2),
		"62 bytes":        envelope("passphrase", argon, WrappedVMKSizeV2+1),
		"v2 weak kdf":     v2("passphrase", weak),
		"bad salt":        envelope("recovery", KDF{Alg: "hkdf-sha256", Salt: "!!"}, WrappedVMKSize),
		"unknown kind":    envelope("backup", hkdf, WrappedVMKSize),
		"salt too short":  envelope("recovery", KDF{Alg: "hkdf-sha256", Salt: base64.StdEncoding.EncodeToString([]byte("abc"))}, WrappedVMKSize),
	} {
		if err := ValidateEnvelope(e); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
}

func TestValidateName(t *testing.T) {
	if n, err := ValidateName("  Diario  "); err != nil || n != "Diario" {
		t.Errorf("trim: %q %v", n, err)
	}
	for _, bad := range []string{"", "   ", "tab\there", string(make([]rune, 121))} {
		if _, err := ValidateName(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}
