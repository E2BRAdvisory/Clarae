package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// S3Options configure an S3-compatible store (MinIO, RustFS, AWS).
type S3Options struct {
	Endpoint     string // host:port or a URL; https unless the URL says http
	AccessKey    string
	SecretKey    string
	Region       string
	Bucket       string
	UsePathStyle bool
	// PublicEndpoint is the address clients reach the store at; when set, PresignGet
	// signs URLs for it (the internal endpoint is often not reachable from outside).
	PublicEndpoint string
}

// S3 is a BlobStore on an S3-compatible bucket.
type S3 struct {
	c      *minio.Client
	pub    *minio.Client // signs URLs for PublicEndpoint; nil when not configured
	bucket string
}

// NewS3 connects and creates the bucket when it does not exist.
func NewS3(ctx context.Context, o S3Options) (*S3, error) {
	endpoint, secure := o.Endpoint, true
	if u, err := url.Parse(o.Endpoint); err == nil && u.Host != "" {
		endpoint, secure = u.Host, u.Scheme == "https"
	}
	lookup := minio.BucketLookupDNS
	if o.UsePathStyle {
		lookup = minio.BucketLookupPath
	}
	newClient := func(endpoint string, secure bool) (*minio.Client, error) {
		return minio.New(endpoint, &minio.Options{
			Creds:        credentials.NewStaticV4(o.AccessKey, o.SecretKey, ""),
			Secure:       secure,
			Region:       o.Region,
			BucketLookup: lookup,
		})
	}
	c, err := newClient(endpoint, secure)
	if err != nil {
		return nil, err
	}
	s := &S3{c: c, bucket: o.Bucket}
	if o.PublicEndpoint != "" {
		pe, psecure := o.PublicEndpoint, true
		if u, err := url.Parse(o.PublicEndpoint); err == nil && u.Host != "" {
			pe, psecure = u.Host, u.Scheme == "https"
		}
		if s.pub, err = newClient(pe, psecure); err != nil {
			return nil, err
		}
	}
	ok, err := c.BucketExists(ctx, o.Bucket)
	if err != nil {
		return nil, fmt.Errorf("s3: check bucket %q: %w", o.Bucket, err)
	}
	if !ok {
		if err := c.MakeBucket(ctx, o.Bucket, minio.MakeBucketOptions{Region: o.Region}); err != nil {
			return nil, fmt.Errorf("s3: create bucket %q: %w", o.Bucket, err)
		}
	}
	return s, nil
}

// Put uploads size bytes (size < 0 streams with multipart).
func (s *S3) Put(ctx context.Context, key string, r io.Reader, size int64) error {
	_, err := s.c.PutObject(ctx, s.bucket, key, r, size, minio.PutObjectOptions{ContentType: "application/octet-stream"})
	return err
}

// Get opens a byte range.
func (s *S3) Get(ctx context.Context, key string, offset, length int64) (io.ReadCloser, error) {
	opts := minio.GetObjectOptions{}
	if offset > 0 || length >= 0 {
		end := int64(0)
		if length >= 0 {
			end = offset + length - 1
		}
		if length == 0 {
			return io.NopCloser(eofReader{}), nil
		}
		if err := opts.SetRange(offset, end); err != nil {
			return nil, err
		}
	}
	obj, err := s.c.GetObject(ctx, s.bucket, key, opts)
	if err != nil {
		return nil, mapErr(err)
	}
	// GetObject is lazy: surface a missing object now.
	if _, err := obj.Stat(); err != nil {
		_ = obj.Close()
		return nil, mapErr(err)
	}
	return obj, nil
}

type eofReader struct{}

func (eofReader) Read([]byte) (int, error) { return 0, io.EOF }

// Size returns the object size.
func (s *S3) Size(ctx context.Context, key string) (int64, error) {
	st, err := s.c.StatObject(ctx, s.bucket, key, minio.StatObjectOptions{})
	if err != nil {
		return 0, mapErr(err)
	}
	return st.Size, nil
}

// Delete removes the object.
func (s *S3) Delete(ctx context.Context, key string) error {
	err := s.c.RemoveObject(ctx, s.bucket, key, minio.RemoveObjectOptions{})
	if err != nil && !errors.Is(mapErr(err), ErrNotFound) {
		return err
	}
	return nil
}

// PresignGet returns a time-limited download URL for the object, or "" when no public
// endpoint is configured (callers then serve the object themselves). Signing is local:
// the region is configured, so no request is made.
func (s *S3) PresignGet(ctx context.Context, key, filename string, ttl time.Duration) (string, error) {
	if s.pub == nil {
		return "", nil
	}
	q := url.Values{}
	if filename != "" {
		q.Set("response-content-disposition", `attachment; filename="`+strings.NewReplacer(`"`, "", `\`, "", "\n", "", "\r", "").Replace(filename)+`"`)
	}
	u, err := s.pub.PresignedGetObject(ctx, s.bucket, key, ttl, q)
	if err != nil {
		return "", err
	}
	return u.String(), nil
}

// Ping checks the bucket is reachable.
func (s *S3) Ping(ctx context.Context) error {
	_, err := s.c.BucketExists(ctx, s.bucket)
	return err
}

func mapErr(err error) error {
	var resp minio.ErrorResponse
	if errors.As(err, &resp) && (resp.Code == "NoSuchKey" || resp.StatusCode == 404) {
		return ErrNotFound
	}
	return err
}
