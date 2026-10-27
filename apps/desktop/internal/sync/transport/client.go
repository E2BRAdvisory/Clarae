// Package transport is the desktop's HTTP client for the MemoBrain Notes Cloud API:
// bearer authentication, request ids, retries with backoff (5xx, 429 with
// Retry-After, network errors) and RFC 9457 problem decoding (§3.1).
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

// New creates a client for serverURL (scheme + host[:port], any path is kept as prefix).
func New(serverURL string, tokens TokenSource, hc *http.Client, userAgent string) (*Client, error) {
	u, err := url.Parse(strings.TrimRight(serverURL, "/"))
	if err != nil || u.Scheme == "" || u.Host == "" {
		return nil, fmt.Errorf("invalid server url %q", serverURL)
	}
	if hc == nil {
		hc = &http.Client{Timeout: 60 * time.Second}
	}
	return &Client{base: u, http: hc, tokens: tokens, userAgent: userAgent, Retries: 3}, nil
}

// BaseURL returns the server URL.
func (c *Client) BaseURL() string { return c.base.String() }

// Do performs a JSON request. When authenticated is true a bearer token is
// attached. out may be nil. Responses with a problem body become *ProblemError.
func (c *Client) Do(ctx context.Context, method, path string, body, out any, authenticated bool) error {
	var payload []byte
	if body != nil {
		var err error
		if payload, err = json.Marshal(body); err != nil {
			return err
		}
	}
	var lastErr error
	for attempt := 0; attempt <= c.Retries; attempt++ {
		if attempt > 0 {
			if err := sleepCtx(ctx, backoff(attempt, lastErr)); err != nil {
				return err
			}
		}
		req, err := http.NewRequestWithContext(ctx, method, c.base.String()+BasePath+path, bytes.NewReader(payload))
		if err != nil {
			return err
		}
		req.Header.Set("Accept", "application/json, application/problem+json")
		req.Header.Set("User-Agent", c.userAgent)
		req.Header.Set("X-Request-Id", uuid.NewString())
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Idempotency-Key", uuid.NewString())
		}
		if authenticated {
			tok, err := c.tokens.Token(ctx)
			if err != nil {
				return err
			}
			req.Header.Set("Authorization", "Bearer "+tok)
		}
		resp, err := c.http.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		err = decode(resp, out)
		var pe *ProblemError
		if errors.As(err, &pe) && (pe.StatusCode >= 500 || pe.StatusCode == http.StatusTooManyRequests) {
			lastErr = err
			continue
		}
		return err
	}
	return lastErr
}

func decode(resp *http.Response, out any) error {
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 400 {
		pe := &ProblemError{StatusCode: resp.StatusCode}
		if err := json.Unmarshal(data, &pe.Problem); err != nil || pe.Problem.Code == "" {
			pe.Problem = syncproto.Problem{Status: resp.StatusCode, Code: syncproto.CodeInternal, Title: http.StatusText(resp.StatusCode), Detail: strings.TrimSpace(string(data))}
		}
		if ra := resp.Header.Get("Retry-After"); ra != "" {
			if pe.Problem.Extra == nil {
				pe.Problem.Extra = map[string]any{}
			}
			pe.Problem.Extra["retry_after"] = ra
		}
		return pe
	}
	if out == nil || resp.StatusCode == http.StatusNoContent || len(data) == 0 {
		return nil
	}
	return json.Unmarshal(data, out)
}

func backoff(attempt int, lastErr error) time.Duration {
	var pe *ProblemError
	if errors.As(lastErr, &pe) {
		if ra, ok := pe.Problem.Extra["retry_after"].(string); ok {
			if secs, err := strconv.Atoi(ra); err == nil && secs > 0 && secs <= 120 {
				return time.Duration(secs) * time.Second
			}
		}
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

// --- API types (mirror api/openapi.yaml) ----------------------------------

// ClientConfig is GET /client-config.
type ClientConfig struct {
	Issuer          string `json:"issuer"`
	DesktopClientID string `json:"desktop_client_id"`
	Audience        string `json:"audience"`
	GRPCEndpoint    string `json:"grpc_endpoint"`
	APIVersion      string `json:"api_version"`
}

// Me is GET /me.
type Me struct {
	ID            string     `json:"id"`
	Username      string     `json:"username"`
	Email         string     `json:"email"`
	DisplayName   *string    `json:"display_name"`
	Role          string     `json:"role"`
	Status        string     `json:"status"`
	QuotaBytes    int64      `json:"quota_bytes"`
	UsedBytes     int64      `json:"used_bytes"`
	ConfigVersion int        `json:"config_version"`
	CreatedAt     time.Time  `json:"created_at"`
	LastLoginAt   *time.Time `json:"last_login_at"`
}

// DeviceRegistration is POST /me/devices.
type DeviceRegistration struct {
	Name       string `json:"name"`
	Platform   string `json:"platform"`
	AppVersion string `json:"app_version,omitempty"`
}

// Device is a registered device.
type Device struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Platform   string     `json:"platform"`
	AppVersion *string    `json:"app_version"`
	CreatedAt  time.Time  `json:"created_at"`
	LastSeenAt *time.Time `json:"last_seen_at"`
}

// GetClientConfig fetches the public bootstrap document.
func (c *Client) GetClientConfig(ctx context.Context) (ClientConfig, error) {
	var out ClientConfig
	err := c.Do(ctx, http.MethodGet, "/client-config", nil, &out, false)
	return out, err
}

// GetMe fetches the caller's profile (provisioning the user on first login).
func (c *Client) GetMe(ctx context.Context) (Me, error) {
	var out Me
	err := c.Do(ctx, http.MethodGet, "/me", nil, &out, true)
	return out, err
}

// RegisterDevice registers this device.
func (c *Client) RegisterDevice(ctx context.Context, reg DeviceRegistration) (Device, error) {
	var out Device
	err := c.Do(ctx, http.MethodPost, "/me/devices", reg, &out, true)
	return out, err
}
