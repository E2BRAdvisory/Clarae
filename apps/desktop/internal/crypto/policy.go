package crypto

import (
	"errors"
	"fmt"
	"unicode/utf8"

	"github.com/trustelem/zxcvbn"
	"golang.org/x/text/unicode/norm"
)

// The passphrase policy of private vaults (§3.8.2), enforced here for every
// binding that sets a new passphrase (creating a private vault, changing the
// passphrase, the new passphrase after the recovery key): the React dialogs
// and the unlock gate of the web page give live feedback with the same rule
// (packages/workbench/src/sync/strength.ts), but the core is the guard. An
// existing passphrase is never checked against it: unlocking, verifying the
// old passphrase or regenerating the recovery key keep working for a vault
// created before the rule (or under an older estimator).
//
// The rule, on the NFC form of the passphrase (what the key derivation uses):
//   - at least MinPassphraseLength code points;
//   - a zxcvbn score of at least MinPassphraseScore, estimated on the first
//     MaxEstimatedLength code points (strength.ts reads the same prefix). The
//     estimator's matching is quadratic in the bytes: 256 CJK characters or
//     emoji take seconds natively and several times that in WebAssembly, 64
//     take tens of milliseconds; a passphrase whose first 64 characters are
//     weak is weak.
//
// The estimator is github.com/trustelem/zxcvbn, a port of zxcvbn 4.4.2 (the
// algorithm of @zxcvbn-ts, scores by guesses); the dictionaries differ a
// little from @zxcvbn-ts's, so a passphrase on the edge may score 2 on one
// side and 3 on the other. The fixtures in shared/conformance/passphrase pin
// the cases both sides must agree on.
const (
	// MinPassphraseLength is the shortest accepted passphrase, in code points.
	MinPassphraseLength = 12
	// MinPassphraseScore is the lowest accepted zxcvbn score (0…4).
	MinPassphraseScore = 3
	// MaxEstimatedLength bounds what the estimator reads, in code points.
	MaxEstimatedLength = 64
)

// Reasons of a WeakPassphraseError: stable, the UI translates them.
const (
	WeakTooShort  = "too-short" // fewer than MinPassphraseLength code points
	WeakGuessable = "guessable" // zxcvbn score below MinPassphraseScore
)

// ErrWeakPassphrase matches every WeakPassphraseError (errors.Is).
var ErrWeakPassphrase = errors.New("weak passphrase")

// ErrShortPassphrase is the WeakPassphraseError of a too short passphrase.
var ErrShortPassphrase error = &WeakPassphraseError{Reason: WeakTooShort}

// WeakPassphraseError refuses a new passphrase; Reason is WeakTooShort or
// WeakGuessable.
type WeakPassphraseError struct {
	Reason string
	Score  int
}

func (e *WeakPassphraseError) Error() string {
	if e.Reason == WeakTooShort {
		return fmt.Sprintf("the passphrase must have at least %d characters", MinPassphraseLength)
	}
	return "the passphrase is too easy to guess: add words or make it longer"
}

// Is makes errors.Is(err, ErrWeakPassphrase) true, and two errors with the
// same reason equal.
func (e *WeakPassphraseError) Is(target error) bool {
	if target == ErrWeakPassphrase {
		return true
	}
	var w *WeakPassphraseError
	return errors.As(target, &w) && w.Reason == e.Reason
}

// PassphraseStrength is the policy's view of a passphrase.
type PassphraseStrength struct {
	// Score is the zxcvbn score, 0 (guessable) … 4 (very strong).
	Score int
	// LongEnough reports at least MinPassphraseLength code points.
	LongEnough bool
	// OK reports a passphrase the policy accepts.
	OK bool
}

// CheckPassphrase estimates a passphrase with the policy's rule.
func CheckPassphrase(p string) PassphraseStrength {
	if !utf8.ValidString(p) {
		return PassphraseStrength{} // never a key: refused as too short
	}
	p = norm.NFC.String(p)
	n := utf8.RuneCountInString(p)
	s := PassphraseStrength{LongEnough: n >= MinPassphraseLength}
	if n == 0 {
		return s
	}
	if n > MaxEstimatedLength {
		p = string([]rune(p)[:MaxEstimatedLength])
	}
	s.Score = zxcvbn.PasswordStrength(p, nil).Score
	s.OK = s.LongEnough && s.Score >= MinPassphraseScore
	return s
}

// ValidatePassphrase enforces the policy on a new passphrase: a
// *WeakPassphraseError when it is too short or too easy to guess.
func ValidatePassphrase(p string) error {
	s := CheckPassphrase(p)
	switch {
	case !s.LongEnough:
		return &WeakPassphraseError{Reason: WeakTooShort, Score: s.Score}
	case !s.OK:
		return &WeakPassphraseError{Reason: WeakGuessable, Score: s.Score}
	}
	return nil
}
