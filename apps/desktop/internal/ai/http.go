package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"
)

// maxErrorBody is how much of a failed response is quoted in the error.
const maxErrorBody = 500

// responseHeaderTimeout bounds the wait for the first byte of an answer.
const responseHeaderTimeout = 90 * time.Second

// NewHTTPClient returns the client of the providers: the default transport with a bound on the wait
// for the headers, and no redirects (a redirect would carry the key to another host: Go strips the
// Authorization header across hosts, but not x-api-key).
func NewHTTPClient() *http.Client {
	rt := http.DefaultTransport
	if t, ok := http.DefaultTransport.(*http.Transport); ok {
		c := t.Clone()
		c.ResponseHeaderTimeout = responseHeaderTimeout
		rt = c
	}
	return &http.Client{Transport: rt, CheckRedirect: noRedirect}
}

func noRedirect(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

// withoutRedirects copies the client of a caller with the rule above.
func withoutRedirects(c *http.Client) *http.Client {
	if c == nil {
		return NewHTTPClient()
	}
	cp := *c
	cp.CheckRedirect = noRedirect
	return &cp
}

// post sends a streaming request and returns the response of a 2xx answer (the caller closes the
// body); any other status is an error that quotes the start of the body, without the key.
func post(ctx context.Context, c *http.Client, url, key string, headers map[string]string, body any) (*http.Response, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return nil, redact(err, key)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := withoutRedirects(c).Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, redact(err, key)
	}
	if resp.StatusCode/100 != 2 {
		defer func() { _ = resp.Body.Close() }()
		// Read a key's length more than is quoted: the key is removed before the cut, so that one
		// straddling the limit is seen whole.
		limit := maxErrorBody + len(key)
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, int64(limit)))
		text := quoteRead(string(snippet), key, len(snippet) >= limit)
		return nil, redact(fmt.Errorf("the provider answered HTTP %d: %s", resp.StatusCode, text), key)
	}
	return resp, nil
}

// redact removes the key from an error (a server may echo what it received, and the URL error of
// net/http quotes the request).
func redact(err error, key string) error {
	if err == nil || key == "" {
		return err
	}
	msg := err.Error()
	if !strings.Contains(msg, key) {
		return err
	}
	return errors.New(strings.ReplaceAll(msg, key, "***"))
}

// printable replaces control characters by spaces and trims: the text goes into a message of the UI.
func printable(s string) string {
	return strings.TrimSpace(strings.Map(func(r rune) rune {
		if isControl(r) {
			return ' '
		}
		return r
	}, s))
}

// quote prepares what a provider said for an error message: the key is removed first and the text
// is cut afterwards, so that a key straddling the limit is not left half-visible.
func quote(text, key string) string { return quoteRead(text, key, false) }

// quoteRead is quote for a text that may have been cut by the reader (truncated): its tail can be
// the beginning of the key, which cannot be recognised. That tail is dropped after the key is
// replaced and before the text is trimmed or cut, because those steps shorten the text and could
// bring the tail into the visible window.
func quoteRead(text, key string, truncated bool) string {
	if key != "" {
		text = strings.ReplaceAll(text, key, "***")
		if truncated {
			for n := min(len(key)-1, len(text)); n > 0; n-- {
				if strings.HasSuffix(text, key[:n]) {
					text = text[:len(text)-n]
					break
				}
			}
		}
	}
	text = printable(text)
	if len(text) > maxErrorBody {
		cut := maxErrorBody
		for cut > 0 && !utf8.RuneStart(text[cut]) {
			cut--
		}
		text = text[:cut]
	}
	return text
}

// providerError builds the error of an error event found inside a stream.
func providerError(kind, message, key string) error {
	msg := quote(message, key)
	if kind != "" {
		msg = quote(kind, key) + ": " + msg
	}
	return redact(fmt.Errorf("the provider reported an error: %s", msg), key)
}
