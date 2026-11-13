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

// During a rolling upgrade pods of 1.4 and of 1.5 share the database (ADR-0052, M17 B4). A pod of 1.4
// takes the per-blob lock under the name "memobrain.blob:<hash>"; 1.5 takes that one first and then
// "clarae.blob:<hash>". These tests act as the pod of 1.4 with the SQL it ran.
const lockAsPod14 = `SELECT pg_advisory_xact_lock(hashtextextended('memobrain.blob:' || $1::text, 0))`

// holdAsPod14 holds the lock of a blob as a pod of 1.4 would, until release is closed.
func (e *env) holdAsPod14(hash string, release <-chan struct{}) (held <-chan struct{}, done <-chan error) {
	h, d := make(chan struct{}), make(chan error, 1)
	go func() {
		d <- e.db.WithTx(context.Background(), func(ctx context.Context, tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, lockAsPod14, hash); err != nil {
				close(h)
				return err
			}
			close(h)
			<-release
			return nil
		})
	}()
	return h, d
}

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

func TestBlobLockOfThisReleaseWaitsForAPodOf14(t *testing.T) {
	e := newEnv(t)
	hash := "ab" + newID()
	release := make(chan struct{})
	releasePod := closer(t, release)
	held, podDone := e.holdAsPod14(hash, release)
	<-held

	locked := make(chan error, 1)
	go func() {
		locked <- e.db.WithTx(context.Background(), func(ctx context.Context, tx pgx.Tx) error {
			_, err := blobs.LockObject(ctx, tx, hash)
			return err
		})
	}()
	if ok, _ := finishesWithin(locked, 400*time.Millisecond); ok {
		t.Fatal("this release took the blob lock while a pod of 1.4 held it")
	}
	releasePod()
	if err := <-podDone; err != nil {
		t.Fatal(err)
	}
	if ok, err := finishesWithin(locked, 10*time.Second); !ok || err != nil {
		t.Fatalf("after the pod of 1.4 released, this release did not get the lock (finished %v, %v)", ok, err)
	}
}

func TestBlobLockOfAPodOf14WaitsForThisRelease(t *testing.T) {
	e := newEnv(t)
	hash := "cd" + newID()
	held, release := make(chan struct{}), make(chan struct{})
	releaseHolder := closer(t, release)
	holder := make(chan error, 1)
	go func() {
		holder <- e.db.WithTx(context.Background(), func(ctx context.Context, tx pgx.Tx) error {
			_, err := blobs.LockObject(ctx, tx, hash)
			close(held)
			<-release
			return err
		})
	}()
	<-held

	release14 := make(chan struct{})
	close(release14) // the pod of 1.4 releases as soon as it has the lock
	_, podDone := e.holdAsPod14(hash, release14)
	if ok, _ := finishesWithin(podDone, 400*time.Millisecond); ok {
		t.Fatal("a pod of 1.4 took the blob lock while this release held it")
	}
	releaseHolder()
	if err := <-holder; err != nil {
		t.Fatal(err)
	}
	if ok, err := finishesWithin(podDone, 10*time.Second); !ok || err != nil {
		t.Fatalf("after this release let go, the pod of 1.4 did not get the lock (finished %v, %v)", ok, err)
	}
}

// Both names are taken in one fixed order, so any mix of pods of both releases on the same blob ends:
// no deadlock (the transactions would otherwise hit the deadlock detector or the timeout below).
func TestBlobLocksOfBothReleasesNeverDeadlock(t *testing.T) {
	e := newEnv(t)
	hash := "ef" + newID()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	var wg sync.WaitGroup
	errs := make(chan error, 40)
	for i := 0; i < 20; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			errs <- e.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
				_, err := blobs.LockObject(ctx, tx, hash)
				time.Sleep(5 * time.Millisecond)
				return err
			})
		}()
		go func() {
			defer wg.Done()
			errs <- e.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
				_, err := tx.Exec(ctx, lockAsPod14, hash)
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

// The first key of AdvisoryLockKeys must hash to what a pod of 1.4 computes in SQL.
func TestLegacyLockKeyIsTheOneOf14(t *testing.T) {
	e := newEnv(t)
	hash := "12" + newID()
	keys := db.AdvisoryLockKeys("blob", hash)
	var same bool
	if err := e.db.Pool.QueryRow(context.Background(),
		`SELECT hashtextextended('memobrain.blob:' || $1::text, 0) = hashtextextended($2::text, 0)`, hash, keys[0]).Scan(&same); err != nil || !same {
		t.Fatalf("legacy key %q does not hash like the one of 1.4 (%v, %v)", keys[0], same, err)
	}
}
