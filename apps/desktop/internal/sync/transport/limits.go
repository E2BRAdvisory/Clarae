package transport

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
)

// Default bounds of a response body (see Client.MaxResponseBytes and
// Client.MaxDownloadBytes). The largest JSON answer is the tree of a vault,
// listed in one response: 128 MiB holds a few hundred thousand entries with
// encrypted paths. A download normally announces its size (WithExpectedSize);
// the default only bounds the others.
const (
	defaultMaxResponseBytes int64 = 128 << 20
	defaultMaxDownloadBytes int64 = 1 << 30
	// maxProblemBytes is what is read of an error response: a problem
	// document is small, anything longer is not one.
	maxProblemBytes int64 = 1 << 20
)

// ErrResponseTooLarge is returned when a response body is larger than the
// bound of its kind: a misbehaving server or proxy, or a body that never ends.
var ErrResponseTooLarge = errors.New("response too large")

type downloadKey struct{}

// download marks a request whose body copyBody streams to the caller, bounded
// by the size in expectedKey or by Client.MaxDownloadBytes.
func download(ctx context.Context) context.Context {
	return context.WithValue(transfer(ctx), downloadKey{}, true)
}

func isDownload(ctx context.Context) bool { return ctx.Value(downloadKey{}) != nil }

type expectedKey struct{}

// WithExpectedSize announces the size of the content a download is about to
// fetch (from the changelog or the tree): GetBlob fails with
// ErrResponseTooLarge instead of reading more. n <= 0 announces nothing.
func WithExpectedSize(ctx context.Context, n int64) context.Context {
	if n <= 0 {
		return ctx
	}
	return context.WithValue(ctx, expectedKey{}, n)
}

// downloadLimit is the bound of a download made with ctx (0 = none).
func (c *Client) downloadLimit(ctx context.Context) int64 {
	if n, ok := ctx.Value(expectedKey{}).(int64); ok && n > 0 {
		return n
	}
	return max(c.MaxDownloadBytes, 0)
}

// limitBody bounds the body of a JSON response. The body of an error is cut
// at maxProblemBytes without failing (only a problem document is looked at);
// a successful one that goes past MaxResponseBytes fails the read, which the
// generated client returns as the error of the call.
func (c *Client) limitBody(resp *http.Response) (*http.Response, error) {
	if resp.StatusCode >= 400 {
		resp.Body = &limitedBody{body: resp.Body, left: maxProblemBytes, quiet: true}
		return resp, nil
	}
	limit := c.MaxResponseBytes
	if limit <= 0 {
		return resp, nil
	}
	if resp.ContentLength > limit {
		discard(resp)
		return nil, tooLarge(resp.ContentLength, limit)
	}
	resp.Body = &limitedBody{body: resp.Body, left: limit, limit: limit}
	return resp, nil
}

func tooLarge(n, limit int64) error {
	if n > 0 {
		return fmt.Errorf("transport: %w: %d bytes, the limit is %d", ErrResponseTooLarge, n, limit)
	}
	return fmt.Errorf("transport: %w: more than %d bytes", ErrResponseTooLarge, limit)
}

// limitedBody reads at most left bytes of body; past them it fails with
// ErrResponseTooLarge, or ends quietly.
type limitedBody struct {
	body        io.ReadCloser
	left, limit int64
	quiet       bool
}

func (b *limitedBody) Read(p []byte) (int, error) {
	if b.left <= 0 {
		if b.quiet {
			return 0, io.EOF
		}
		// One more byte tells a body of exactly the limit from a longer one.
		var one [1]byte
		if n, err := b.body.Read(one[:]); n == 0 {
			return 0, err
		}
		return 0, tooLarge(0, b.limit)
	}
	if int64(len(p)) > b.left {
		p = p[:b.left]
	}
	n, err := b.body.Read(p)
	b.left -= int64(n)
	return n, err
}

func (b *limitedBody) Close() error { return b.body.Close() }
