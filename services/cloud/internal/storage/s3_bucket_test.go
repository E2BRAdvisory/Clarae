package storage

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/minio/minio-go/v7"
)

// fakeBuckets is an object store that only knows its bucket names.
type fakeBuckets struct {
	buckets map[string]bool
	created []string
	err     error
}

func (f *fakeBuckets) BucketExists(_ context.Context, name string) (bool, error) {
	return f.buckets[name], f.err
}

func (f *fakeBuckets) MakeBucket(_ context.Context, name string, _ minio.MakeBucketOptions) error {
	f.buckets[name] = true
	f.created = append(f.created, name)
	return nil
}

func TestEnsureBucket(t *testing.T) {
	const oldName, newName = "memobrain-blobs", "clarae-blobs"
	opts := S3Options{Bucket: newName, LegacyBucket: oldName, BucketSetting: "S3_BUCKET_BLOBS"}

	t.Run("a new installation creates the bucket", func(t *testing.T) {
		f := &fakeBuckets{buckets: map[string]bool{}}
		if err := ensureBucket(context.Background(), f, opts); err != nil || len(f.created) != 1 || f.created[0] != newName {
			t.Fatalf("err %v, created %v", err, f.created)
		}
	})

	t.Run("an existing bucket is left alone", func(t *testing.T) {
		f := &fakeBuckets{buckets: map[string]bool{newName: true, oldName: true}}
		if err := ensureBucket(context.Background(), f, opts); err != nil || len(f.created) != 0 {
			t.Fatalf("err %v, created %v", err, f.created)
		}
	})

	// The upgrade without the new variable: the default points at a bucket that does not exist
	// while the data sits in the old one. Creating the new one would hide every blob.
	t.Run("the default would hide the bucket of 1.x", func(t *testing.T) {
		f := &fakeBuckets{buckets: map[string]bool{oldName: true}}
		err := ensureBucket(context.Background(), f, opts)
		if !errors.Is(err, ErrLegacyBucket) {
			t.Fatalf("got %v, want ErrLegacyBucket", err)
		}
		for _, want := range []string{"S3_BUCKET_BLOBS=" + oldName, newName, oldName} {
			if !strings.Contains(err.Error(), want) {
				t.Errorf("the error does not mention %q: %v", want, err)
			}
		}
		if len(f.created) != 0 {
			t.Fatalf("created %v although it refused", f.created)
		}
	})

	t.Run("an explicit name is never second-guessed", func(t *testing.T) {
		f := &fakeBuckets{buckets: map[string]bool{oldName: true}}
		explicit := S3Options{Bucket: newName} // the caller leaves LegacyBucket empty
		if err := ensureBucket(context.Background(), f, explicit); err != nil || len(f.created) != 1 {
			t.Fatalf("err %v, created %v", err, f.created)
		}
	})

	t.Run("the legacy name itself is just a bucket", func(t *testing.T) {
		f := &fakeBuckets{buckets: map[string]bool{}}
		same := S3Options{Bucket: oldName, LegacyBucket: oldName}
		if err := ensureBucket(context.Background(), f, same); err != nil || len(f.created) != 1 {
			t.Fatalf("err %v, created %v", err, f.created)
		}
	})

	t.Run("a failing store is an error, not a creation", func(t *testing.T) {
		f := &fakeBuckets{buckets: map[string]bool{}, err: errors.New("unreachable")}
		if err := ensureBucket(context.Background(), f, opts); err == nil || len(f.created) != 0 {
			t.Fatalf("err %v, created %v", err, f.created)
		}
	})
}
