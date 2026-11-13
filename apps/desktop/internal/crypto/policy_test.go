package crypto

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/text/unicode/norm"

	"clarae/apps/desktop/internal/sync/transport"
	"clarae/shared/conformance"
	"clarae/shared/vaultcrypto"
)

type policyFixture struct {
	MinLength int `json:"minLength"`
	MinScore  int `json:"minScore"`
	MaxLength int `json:"maxEstimatedLength"`
	Cases     []struct {
		Note       string `json:"note"`
		Passphrase string `json:"passphrase"`
		OK         bool   `json:"ok"`
		Reason     string `json:"reason"`
	} `json:"cases"`
}

// The cases of shared/conformance/passphrase/policy.json, which the
// workbench's live check (strength.ts) runs too: both sides accept and refuse
// the same passphrases, for the same reason.
func TestPassphrasePolicyFixtures(t *testing.T) {
	dir, err := conformance.Dir("passphrase")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "policy.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f policyFixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if f.MinLength != MinPassphraseLength || f.MinScore != MinPassphraseScore || f.MaxLength != MaxEstimatedLength {
		t.Fatalf("fixture rule %d/%d/%d, core %d/%d/%d", f.MinLength, f.MinScore, f.MaxLength, MinPassphraseLength, MinPassphraseScore, MaxEstimatedLength)
	}
	if len(f.Cases) < 10 {
		t.Fatalf("only %d cases", len(f.Cases))
	}
	for _, c := range f.Cases {
		err := ValidatePassphrase(c.Passphrase)
		if c.OK {
			if err != nil {
				t.Errorf("%q (%s): refused: %v (score %d)", c.Passphrase, c.Note, err, CheckPassphrase(c.Passphrase).Score)
			}
			continue
		}
		var w *WeakPassphraseError
		if !errors.As(err, &w) || w.Reason != c.Reason {
			t.Errorf("%q (%s): %v, want reason %s", c.Passphrase, c.Note, err, c.Reason)
		}
	}
}

func TestPassphrasePolicy(t *testing.T) {
	decomposed := "càffè latte molto caldo"
	if norm.NFC.String(decomposed) == decomposed {
		t.Fatal("the test needs a passphrase that is not in NFC")
	}
	for _, c := range []struct {
		name, pass, reason string
	}{
		{"empty", "", WeakTooShort},
		{"eleven", "abcdefghijk", WeakTooShort},
		// 11 letters, 22 code points decomposed: the length is the NFC one.
		{"nfd counted in nfc", norm.NFD.String("àèìòùáéíóúý"), WeakTooShort},
		{"invalid utf-8", "correct horse \xff battery staple", WeakTooShort},
		{"repeated", "aaaaaaaaaaaa", WeakGuessable},
		{"common", "passwordpassword", WeakGuessable},
		{"keyboard", "qwertyuiopasdf", WeakGuessable},
		{"leet", "P@ssw0rdP@ssw0rd", WeakGuessable},
		{"long but repeated", strings.Repeat("a", 300), WeakGuessable},
		{"words", "correct horse battery staple", ""},
		{"composed", "càffè latte molto caldo", ""},
		{"decomposed", decomposed, ""},
		{"cyrillic", "пароль пароль пароль", ""},
		{"cjk", "日本語のパスフレーズです", ""},
		// Beyond the estimated prefix the rest does not count against it.
		{"long", strings.Repeat("frog lamp orbit cello ", 20), ""},
	} {
		err := ValidatePassphrase(c.pass)
		if c.reason == "" {
			if err != nil {
				t.Errorf("%s: %v", c.name, err)
			}
			continue
		}
		var w *WeakPassphraseError
		if !errors.As(err, &w) || w.Reason != c.reason {
			t.Errorf("%s: %v, want %s", c.name, err, c.reason)
		}
		if !errors.Is(err, ErrWeakPassphrase) {
			t.Errorf("%s: not ErrWeakPassphrase", c.name)
		}
	}
	if !errors.Is(ValidatePassphrase("short"), ErrShortPassphrase) {
		t.Error("a short passphrase is ErrShortPassphrase")
	}
	if errors.Is(ValidatePassphrase("aaaaaaaaaaaa"), ErrShortPassphrase) {
		t.Error("a guessable passphrase is not ErrShortPassphrase")
	}
	if s := CheckPassphrase("correct horse battery staple"); !s.OK || !s.LongEnough || s.Score < MinPassphraseScore {
		t.Errorf("strength %+v", s)
	}
}

// Only new passphrases meet the policy: a vault created under a weaker rule
// still unlocks (and has its envelope re-wrapped in v2), verifies its
// passphrase and regenerates its recovery key; only a new passphrase is checked.
func TestPolicyIsNotAppliedToExistingPassphrases(t *testing.T) {
	const weak = "aaaaaaaaaaaa" // accepted by the length-only rule of earlier versions
	if err := ValidatePassphrase(weak); err == nil {
		t.Fatal("the test needs a passphrase the policy refuses")
	}
	m, _, _ := newManager(t)
	if _, err := m.NewMaterial(weak); !errors.Is(err, ErrWeakPassphrase) {
		t.Fatalf("new material with a weak passphrase: %v", err)
	}
	vmk, _ := vaultcrypto.GenerateVMK()
	kdf := vaultcrypto.NewPassphraseKDF(0, 0, 0)
	kek, err := vaultcrypto.DeriveKEKPassphrase(weak, kdf)
	if err != nil {
		t.Fatal(err)
	}
	w, _ := vaultcrypto.Wrap(kek, vmk)
	envs := []transport.KeyEnvelope{{Kind: KindPassphrase, Kdf: kdfToTransport(kdf), WrappedVmk: w}}
	res, err := m.UnlockWith(vaultID, envs, weak, false, UnlockOptions{})
	if err != nil {
		t.Fatalf("unlock with an old weak passphrase: %v", err)
	}
	if res.Upgrade == nil {
		t.Fatal("the v2 re-wrap of an old weak passphrase must not be refused")
	}
	if err := m.VerifyPassphrase(vaultID, envs, weak); err != nil {
		t.Fatalf("verify an old weak passphrase: %v", err)
	}
	if _, _, err := m.NewRecoveryEnvelope(vaultID); err != nil {
		t.Fatalf("new recovery key: %v", err)
	}
	if _, err := m.NewPassphraseEnvelope(vaultID, weak+"a"); !errors.Is(err, ErrWeakPassphrase) {
		t.Fatalf("a weak new passphrase: %v", err)
	}
	if _, err := m.NewPassphraseEnvelope(vaultID, "correct horse battery staple"); err != nil {
		t.Fatalf("a strong new passphrase: %v", err)
	}
}
