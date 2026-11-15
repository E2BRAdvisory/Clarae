//go:build integration

package integration

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"clarae/services/cloud/internal/blobs"
	"clarae/services/cloud/internal/db"
)

// The per-blob advisory lock (blobs.LockObject, the one of the upload and of the garbage collector):
// two transactions on the same hash exclude each other, two on different hashes do not.

// closer returns a function that closes ch once, and closes it when the test ends, so that a failed
// assertion does not leave a transaction holding a lock (the database would not close).
func closer(t *testing.T, ch chan struct{}) func() {
	t.Helper()
	var once sync.Once
	closeOnce := func() { once.Do(func() { close(ch) }) }
	t.Cleanup(closeOnce)
	return closeOnce
}

// finishesWithin reports whether done delivers within d.
func finishesWithin(done <-chan error, d time.Duration) (bool, error) {
	select {
	case err := <-done:
		return true, err
	case <-time.After(d):
		return false, nil
	}
}

// holdBlobLock takes the lock of a blob in a transaction that stays open until release is closed.
func (e *env) holdBlobLock(hash string, release <-chan struct{}) (held <-chan struct{}, done <-chan error) {
	h, d := make(chan struct{}), make(chan error, 1)
	go func() {
		d <- e.db.WithTx(context.Background(), func(ctx context.Context, tx pgx.Tx) error {
			_, err := blobs.LockObject(ctx, tx, hash)
			close(h)
			if err != nil {
				return err
			}
			<-release
			return nil
		})
	}()
	return h, d
}

func TestBlobLockExcludesAnotherTransactionOnTheSameHash(t *testing.T) {
	e := newEnv(t)
	hash := "ab" + newID()
	release := make(chan struct{})
	releaseHolder := closer(t, release)
	held, holderDone := e.holdBlobLock(hash, release)
	<-held

	second := make(chan struct{})
	closeSecond := closer(t, second)
	closeSecond() // the second transaction lets go as soon as it has the lock
	_, secondDone := e.holdBlobLock(hash, second)
	if ok, _ := finishesWithin(secondDone, 400*time.Millisecond); ok {
		t.Fatal("a second transaction took the blob lock while the first held it")
	}
	releaseHolder()
	if err := <-holderDone; err != nil {
		t.Fatal(err)
	}
	if ok, err := finishesWithin(secondDone, 10*time.Second); !ok || err != nil {
		t.Fatalf("after the first transaction let go, the second did not get the lock (finished %v, %v)", ok, err)
	}
}

func TestBlobLockDoesNotBlockAnotherHash(t *testing.T) {
	e := newEnv(t)
	release := make(chan struct{})
	releaseHolder := closer(t, release)
	held, holderDone := e.holdBlobLock("cd"+newID(), release)
	<-held

	other := make(chan error, 1)
	go func() {
		other <- e.db.WithTx(context.Background(), func(ctx context.Context, tx pgx.Tx) error {
			_, err := blobs.LockObject(ctx, tx, "ef"+newID())
			return err
		})
	}()
	if ok, err := finishesWithin(other, 10*time.Second); !ok || err != nil {
		t.Fatalf("the lock of a blob blocked another blob (finished %v, %v)", ok, err)
	}
	releaseHolder()
	if err := <-holderDone; err != nil {
		t.Fatal(err)
	}
}

// Many transactions on one hash all end: the lock is a single key, so there is nothing to deadlock on.
func TestBlobLockUnderContentionEnds(t *testing.T) {
	e := newEnv(t)
	hash := "12" + newID()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	var wg sync.WaitGroup
	errs := make(chan error, 40)
	for i := 0; i < 40; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- e.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
				_, err := blobs.LockObject(ctx, tx, hash)
				time.Sleep(5 * time.Millisecond)
				return err
			})
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("a locking transaction failed: %v", err)
		}
	}
}

// The key the code takes is the one this lock is documented under: "clarae.<kind>:<id>" hashed by
// hashtextextended, which is what the Lock* queries do.
func TestBlobLockKeyIsTheCurrentName(t *testing.T) {
	e := newEnv(t)
	hash := "34" + newID()
	keys := db.AdvisoryLockKeys("blob", hash)
	if len(keys) != 1 {
		t.Fatalf("AdvisoryLockKeys returned %d keys, want 1", len(keys))
	}
	var same bool
	if err := e.db.Pool.QueryRow(context.Background(),
		`SELECT hashtextextended('clarae.blob:' || $1::text, 0) = hashtextextended($2::text, 0)`, hash, keys[0]).Scan(&same); err != nil || !same {
		t.Fatalf("key %q does not hash like clarae.blob:<hash> (%v, %v)", keys[0], same, err)
	}
}
