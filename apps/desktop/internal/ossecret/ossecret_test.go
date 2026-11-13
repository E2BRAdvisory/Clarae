package ossecret

import (
	"errors"
	"testing"
)

const (
	current = "Clarae notanda"
	old1    = "legacy one"
	old2    = "legacy two"
)

// fake is a keychain in memory; the maps of errors make one call fail.
type fake struct {
	items                  map[[2]string]string
	getErr, setErr, delErr map[string]error // by service
	sets                   [][2]string
}

func newFake() *fake {
	return &fake{items: map[[2]string]string{}, getErr: map[string]error{}, setErr: map[string]error{}, delErr: map[string]error{}}
}

func (f *fake) Get(service, account string) (string, error) {
	if err := f.getErr[service]; err != nil {
		return "", err
	}
	v, ok := f.items[[2]string{service, account}]
	if !ok {
		return "", ErrNotFound
	}
	return v, nil
}

func (f *fake) Set(service, account, secret string) error {
	if err := f.setErr[service]; err != nil {
		return err
	}
	f.sets = append(f.sets, [2]string{service, account})
	f.items[[2]string{service, account}] = secret
	return nil
}

func (f *fake) Delete(service, account string) error {
	if err := f.delErr[service]; err != nil {
		return err
	}
	if _, ok := f.items[[2]string{service, account}]; !ok {
		return ErrNotFound
	}
	delete(f.items, [2]string{service, account})
	return nil
}

func (f *fake) has(service, account string) bool {
	_, ok := f.items[[2]string{service, account}]
	return ok
}

func store(f *fake) Store { return Store{Backend: f, Service: current, Legacy: []string{old1, old2}} }

func TestGetPrefersTheCurrentService(t *testing.T) {
	f := newFake()
	f.items[[2]string{current, "a"}] = "new"
	f.items[[2]string{old1, "a"}] = "old"
	got, err := store(f).Get("a")
	if err != nil || got != "new" {
		t.Fatalf("Get = %q, %v", got, err)
	}
	if len(f.sets) != 0 {
		t.Fatalf("nothing to copy, but Set was called: %v", f.sets)
	}
}

// The user of 1.x finds the secret where 1.x put it, and it moves to the new service on the way.
func TestGetFallsBackToTheLegacyServiceAndCopiesIt(t *testing.T) {
	f := newFake()
	f.items[[2]string{old2, "refresh-token:https://x"}] = "tok"
	got, err := store(f).Get("refresh-token:https://x")
	if err != nil || got != "tok" {
		t.Fatalf("Get = %q, %v", got, err)
	}
	if !f.has(current, "refresh-token:https://x") {
		t.Fatal("the secret was not copied to the current service")
	}
	if !f.has(old2, "refresh-token:https://x") {
		t.Fatal("a read must not delete the legacy copy: the old version may still use it")
	}
	// The second read does not need the fallback any more.
	f.getErr[old2] = errors.New("must not be asked")
	if got, err := store(f).Get("refresh-token:https://x"); err != nil || got != "tok" {
		t.Fatalf("second Get = %q, %v", got, err)
	}
}

func TestGetSearchesTheLegacyServicesInOrder(t *testing.T) {
	f := newFake()
	f.items[[2]string{old1, "a"}] = "first"
	f.items[[2]string{old2, "a"}] = "second"
	if got, _ := store(f).Get("a"); got != "first" {
		t.Fatalf("Get = %q, want the first legacy service", got)
	}
}

func TestGetOfAMissingSecretIsEmpty(t *testing.T) {
	got, err := store(newFake()).Get("a")
	if err != nil || got != "" {
		t.Fatalf("Get = %q, %v", got, err)
	}
}

// A copy that fails does not fail the read: the secret is good, and the next read tries again.
func TestGetSurvivesAFailedCopy(t *testing.T) {
	f := newFake()
	f.items[[2]string{old1, "a"}] = "tok"
	f.setErr[current] = errors.New("keychain locked")
	got, err := store(f).Get("a")
	if err != nil || got != "tok" {
		t.Fatalf("Get = %q, %v", got, err)
	}
}

// A keychain that cannot be read is not a missing secret: the caller must not sign out, nor treat
// a private vault as locked for good.
func TestGetReportsAnUnreadableKeychain(t *testing.T) {
	boom := errors.New("keychain locked")
	f := newFake()
	f.items[[2]string{old1, "a"}] = "tok"
	f.getErr[current] = boom
	if _, err := store(f).Get("a"); !errors.Is(err, boom) {
		t.Fatalf("current service unreadable: %v", err)
	}
	f.getErr[current] = nil
	f.getErr[old1] = boom
	if _, err := store(f).Get("a"); !errors.Is(err, boom) {
		t.Fatalf("legacy service unreadable: %v", err)
	}
}

func TestSetWritesTheCurrentServiceAndRemovesTheLegacyCopies(t *testing.T) {
	f := newFake()
	f.items[[2]string{old1, "a"}] = "stale"
	f.items[[2]string{old2, "a"}] = "stale"
	if err := store(f).Set("a", "fresh"); err != nil {
		t.Fatal(err)
	}
	if f.items[[2]string{current, "a"}] != "fresh" || f.has(old1, "a") || f.has(old2, "a") {
		t.Fatalf("keychain after Set: %v", f.items)
	}
}

// If the write fails the legacy copy is all that is left: it must not be touched.
func TestSetKeepsTheLegacyCopyWhenTheWriteFails(t *testing.T) {
	f := newFake()
	f.items[[2]string{old1, "a"}] = "old"
	f.setErr[current] = errors.New("denied")
	if err := store(f).Set("a", "fresh"); err == nil {
		t.Fatal("the failure must be reported")
	}
	if !f.has(old1, "a") {
		t.Fatal("the legacy copy was deleted although nothing was written")
	}
}

func TestSetIgnoresAFailedLegacyRemoval(t *testing.T) {
	f := newFake()
	f.items[[2]string{old1, "a"}] = "stale"
	f.delErr[old1] = errors.New("denied")
	if err := store(f).Set("a", "fresh"); err != nil {
		t.Fatalf("Set = %v: the new secret is written", err)
	}
}

// After a sign-out or the lock of a vault the next read must not find the secret again.
func TestDeleteRemovesEveryCopy(t *testing.T) {
	f := newFake()
	f.items[[2]string{current, "a"}] = "x"
	f.items[[2]string{old1, "a"}] = "y"
	f.items[[2]string{old2, "a"}] = "z"
	f.items[[2]string{current, "other"}] = "keep"
	s := store(f)
	if err := s.Delete("a"); err != nil {
		t.Fatal(err)
	}
	if got, err := s.Get("a"); err != nil || got != "" {
		t.Fatalf("after Delete, Get = %q, %v", got, err)
	}
	if !f.has(current, "other") {
		t.Fatal("another account was deleted")
	}
}

func TestDeleteOfAMissingSecretIsNotAnError(t *testing.T) {
	if err := store(newFake()).Delete("a"); err != nil {
		t.Fatal(err)
	}
}

// A failure on one service does not stop the others, and is reported.
func TestDeleteTriesEveryServiceAndReportsTheFirstFailure(t *testing.T) {
	boom := errors.New("denied")
	f := newFake()
	f.items[[2]string{current, "a"}] = "x"
	f.items[[2]string{old1, "a"}] = "y"
	f.items[[2]string{old2, "a"}] = "z"
	f.delErr[old1] = boom
	if err := store(f).Delete("a"); !errors.Is(err, boom) {
		t.Fatalf("Delete = %v", err)
	}
	if f.has(current, "a") || f.has(old2, "a") || !f.has(old1, "a") {
		t.Fatalf("keychain after Delete: %v", f.items)
	}
}
