// Package transport is the desktop's HTTP client for the MemoBrain Notes Cloud API.
//
// Requests, parameters and payloads come from the client generated from
// api/openapi.yaml (memobrain/shared/apiclient, ADR-0037 §3); this package is the
// thin layer around it: bearer authentication, request ids, idempotency keys,
// retries with backoff (5xx, 429 with Retry-After, network errors), RFC 9457
// problem decoding into typed errors (§3.1) and the engine's view of the sync
// payloads. The routes outside the contract, tus uploads (tus.go) and the SSE
// stream (notify.go), are implemented here by hand.
package transport

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"memobrain/shared/apiclient"
	"memobrain/shared/syncproto"
)

// BasePath of the REST API.
const BasePath = "/api/v1"

// TokenSource provides a valid bearer token (refreshing it when needed).
type TokenSource interface {
	Token(ctx context.Context) (string, error)
}

// Client talks to one cloud server.
type Client struct {
	base      *url.URL
	http      *http.Client
	tokens    TokenSource
	userAgent string
	api       *apiclient.ClientWithResponses
	// Retries bounds the number of attempts for retryable failures.
	Retries int
}

// ProblemError is an API error response.
type ProblemError struct {
	Problem    syncproto.Problem
	StatusCode int
}

func (e *ProblemError) Error() string {
	if e.Problem.Detail != "" {
		return fmt.Sprintf("%s: %s", e.Problem.Code, e.Problem.Detail)
	}
	return fmt.Sprintf("%s (%d)", e.Problem.Code, e.StatusCode)
}

// Is lets callers match on the application code: errors.Is(err, CodeError(syncproto.CodeNotFound)).
func (e *ProblemError) Is(target error) bool {
	var ce CodeError
	if errors.As(target, &ce) {
		return e.Problem.Code == syncproto.Code(ce)
	}
	return false
}

// CodeError is a sentinel for matching ProblemError codes with errors.Is.
type CodeError syncproto.Code

func (c CodeError) Error() string { return string(c) }

// IsCode reports whether err is an API problem with the given code.
func IsCode(err error, code syncproto.Code) bool {
	var pe *ProblemError
	return errors.As(err, &pe) && pe.Problem.Code == code
}

// New creates a client for serverURL (scheme + host[:port], any path is kept as prefix).
// tokens may be nil for a client that only calls public operations (GetClientConfig).
func New(serverURL string, tokens TokenSource, hc *http.Client, userAgent string) (*Client, error) {
	u, err := url.Parse(strings.TrimRight(serverURL, "/"))
	if err != nil || u.Scheme == "" || u.Host == "" {
		return nil, fmt.Errorf("invalid server url %q", serverURL)
	}
	if hc == nil {
		hc = &http.Client{Timeout: 60 * time.Second}
	}
	c := &Client{base: u, http: hc, tokens: tokens, userAgent: userAgent, Retries: 3}
	if c.api, err = apiclient.NewClientWithResponses(u.String()+BasePath, apiclient.WithHTTPClient(doer{c})); err != nil {
		return nil, err
	}
	return c, nil
}

// BaseURL returns the server URL.
func (c *Client) BaseURL() string { return c.base.String() }

// --- request pipeline ----------------------------------------------------------

type publicKey struct{}

// public marks a request that must not carry a bearer token.
func public(ctx context.Context) context.Context { return context.WithValue(ctx, publicKey{}, true) }

// doer is the HttpRequestDoer of the generated client: every request of the
// contract goes through Client.send.
type doer struct{ c *Client }

func (d doer) Do(req *http.Request) (*http.Response, error) {
	if req.Header.Get("Accept") == "" {
		req.Header.Set("Accept", "application/json, application/problem+json")
	}
	return d.c.send(req, req.Context().Value(publicKey{}) == nil)
}

// send performs req, retrying network errors, 5xx and 429 (honouring
// Retry-After) up to Retries times. Each attempt is a clone of req with a fresh
// X-Request-Id and the body rewound, so the headers chosen once per logical
// operation, the Idempotency-Key above all, are the same on every attempt.
// When the attempts run out on a retryable status the last response is
// returned unread, for the caller to decode as a problem.
func (c *Client) send(req *http.Request, authenticated bool) (*http.Response, error) {
	ctx := req.Context()
	if req.Body != nil && req.Body != http.NoBody && req.GetBody == nil {
		return nil, errors.New("transport: request body must be rewindable for retries")
	}
	var lastErr error
	var retryAfter time.Duration
	for attempt := 0; attempt <= c.Retries; attempt++ {
		if attempt > 0 {
			if err := sleepCtx(ctx, backoff(attempt, retryAfter)); err != nil {
				return nil, err
			}
		}
		r := req.Clone(ctx)
		if req.GetBody != nil {
			body, err := req.GetBody()
			if err != nil {
				return nil, err
			}
			r.Body = body
		}
		r.Header.Set("User-Agent", c.userAgent)
		r.Header.Set("X-Request-Id", uuid.NewString())
		if authenticated {
			if c.tokens == nil {
				return nil, errors.New("transport: not signed in")
			}
			tok, err := c.tokens.Token(ctx)
			if err != nil {
				return nil, err
			}
			r.Header.Set("Authorization", "Bearer "+tok)
		}
		resp, err := c.http.Do(r) //nolint:gosec // G704: requests go to the server the user signed in to
		if err != nil {
			if ctx.Err() != nil {
				return nil, err
			}
			lastErr, retryAfter = err, 0
			continue
		}
		if (resp.StatusCode >= 500 || resp.StatusCode == http.StatusTooManyRequests) && attempt < c.Retries {
			retryAfter = parseRetryAfter(resp.Header.Get("Retry-After"))
			lastErr = decodeProblem(resp)
			continue
		}
		return resp, nil
	}
	return nil, lastErr
}

// raw performs a request outside the generated client (tus, binary bodies
// built by hand) through the same pipeline. body may be nil.
func (c *Client) raw(ctx context.Context, method, path string, body []byte, headers map[string]string) (*http.Response, error) {
	var rdr io.Reader
	if body != nil {
		rdr = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base.String()+BasePath+path, rdr)
	if err != nil {
		return nil, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	return c.send(req, true)
}

// idempotencyKey returns a new key for one logical operation; the caller puts
// it in the generated parameters once, so every retry of the request reuses it.
func idempotencyKey() *string {
	k := uuid.NewString()
	return &k
}

// decodeProblem reads and closes an error response.
func decodeProblem(resp *http.Response) error {
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}
	return problemOf(resp, data)
}

// problemOf turns an error response (status >= 400) into a *ProblemError.
// A body that is not a problem document becomes an INTERNAL problem carrying
// the text, so callers always get a code to match on.
func problemOf(resp *http.Response, body []byte) error {
	pe := &ProblemError{StatusCode: resp.StatusCode}
	var p apiclient.Problem
	if err := json.Unmarshal(body, &p); err == nil && p.Code != "" {
		pe.Problem = syncproto.Problem{Type: p.Type, Title: p.Title, Status: p.Status, Code: syncproto.Code(p.Code), Detail: deref(p.Detail), RequestID: deref(p.RequestId)}
		if p.Extra != nil {
			pe.Problem.Extra = *p.Extra
		}
	} else {
		pe.Problem = syncproto.Problem{Status: resp.StatusCode, Code: syncproto.CodeInternal, Title: http.StatusText(resp.StatusCode), Detail: strings.TrimSpace(string(body))}
	}
	if ra := resp.Header.Get("Retry-After"); ra != "" {
		if pe.Problem.Extra == nil {
			pe.Problem.Extra = map[string]any{}
		}
		pe.Problem.Extra["retry_after"] = ra
	}
	return pe
}

// want returns the decoded body of a successful response, or the problem of
// a failed one. v is what the generated parser decoded; it is nil when the
// status is not the documented one or the Content-Type is not JSON, in which
// case a JSON body is still accepted (a proxy may drop the header).
func want[T any](resp *http.Response, body []byte, v *T) (T, error) {
	var zero T
	if resp.StatusCode >= 400 {
		return zero, problemOf(resp, body)
	}
	if v != nil {
		return *v, nil
	}
	var out T
	if resp.StatusCode >= 200 && resp.StatusCode < 300 && len(body) > 0 && json.Unmarshal(body, &out) == nil {
		return out, nil
	}
	return zero, fmt.Errorf("unexpected response: HTTP %d (%s)", resp.StatusCode, resp.Header.Get("Content-Type"))
}

// ok checks a response without a body to decode (204 and the like).
func ok(resp *http.Response, body []byte) error {
	if resp.StatusCode >= 400 {
		return problemOf(resp, body)
	}
	return nil
}

func parseRetryAfter(v string) time.Duration {
	if secs, err := strconv.Atoi(v); err == nil && secs > 0 && secs <= 120 {
		return time.Duration(secs) * time.Second
	}
	return 0
}

func backoff(attempt int, retryAfter time.Duration) time.Duration {
	if retryAfter > 0 {
		return retryAfter
	}
	d := time.Duration(1<<uint(attempt-1)) * 500 * time.Millisecond
	if d > 8*time.Second {
		d = 8 * time.Second
	}
	return d + time.Duration(time.Now().UnixNano()%int64(250*time.Millisecond))
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// parseID converts an identifier of the transport API (strings, as stored by
// the sync engine) into the UUID the contract requires.
func parseID(what, id string) (uuid.UUID, error) {
	u, err := uuid.Parse(id)
	if err != nil {
		return uuid.UUID{}, fmt.Errorf("invalid %s id %q", what, id)
	}
	return u, nil
}

func deref[T any](p *T) T {
	var zero T
	if p == nil {
		return zero
	}
	return *p
}

func ptrIf[T comparable](v T) *T {
	var zero T
	if v == zero {
		return nil
	}
	return &v
}

func idString(p *uuid.UUID) string {
	if p == nil {
		return ""
	}
	return p.String()
}

// --- account -----------------------------------------------------------------

// API types of the account endpoints (generated from api/openapi.yaml).
type (
	// ClientConfig is GET /client-config.
	ClientConfig = apiclient.ClientConfig
	// Me is GET /me.
	Me = apiclient.Me
	// DeviceRegistration is the body of POST /me/devices.
	DeviceRegistration = apiclient.DeviceRegistration
	// Device is a registered device.
	Device = apiclient.Device
	// Usage is GET /me/usage.
	Usage = apiclient.Usage
)

// GetClientConfig fetches the public bootstrap document.
func (c *Client) GetClientConfig(ctx context.Context) (ClientConfig, error) {
	res, err := c.api.GetClientConfigWithResponse(public(ctx))
	if err != nil {
		return ClientConfig{}, err
	}
	return want(res.HTTPResponse, res.Body, res.JSON200)
}

// GetMe fetches the caller's profile (provisioning the user on first login).
func (c *Client) GetMe(ctx context.Context) (Me, error) {
	res, err := c.api.GetMeWithResponse(ctx)
	if err != nil {
		return Me{}, err
	}
	return want(res.HTTPResponse, res.Body, res.JSON200)
}

// RegisterDevice registers this device.
func (c *Client) RegisterDevice(ctx context.Context, reg DeviceRegistration) (Device, error) {
	res, err := c.api.RegisterDeviceWithResponse(ctx, &apiclient.RegisterDeviceParams{IdempotencyKey: idempotencyKey()}, reg)
	if err != nil {
		return Device{}, err
	}
	return want(res.HTTPResponse, res.Body, res.JSON201)
}

// ListDevices returns the caller's active devices.
func (c *Client) ListDevices(ctx context.Context) ([]Device, error) {
	res, err := c.api.ListMyDevicesWithResponse(ctx)
	if err != nil {
		return nil, err
	}
	list, err := want(res.HTTPResponse, res.Body, res.JSON200)
	return list.Items, err
}

// RevokeDevice revokes a device.
func (c *Client) RevokeDevice(ctx context.Context, id string) error {
	did, err := parseID("device", id)
	if err != nil {
		return err
	}
	res, err := c.api.RevokeDeviceWithResponse(ctx, did)
	if err != nil {
		return err
	}
	return ok(res.HTTPResponse, res.Body)
}

// GetUsage returns the storage usage of the caller.
func (c *Client) GetUsage(ctx context.Context) (Usage, error) {
	res, err := c.api.GetMyUsageWithResponse(ctx)
	if err != nil {
		return Usage{}, err
	}
	return want(res.HTTPResponse, res.Body, res.JSON200)
}
