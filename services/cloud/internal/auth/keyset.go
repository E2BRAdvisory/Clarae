package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/go-jose/go-jose/v4"
)

// The JWKS refresh policy. go-oidc's RemoteKeySet fetches the key set again
// for every token that no cached key verifies, so forged tokens (an unknown
// kid, or a random signature) cost one request to the identity provider each.
// This key set refreshes at most once per keyRefreshInterval, except for a
// key id it has never seen, which is what a key rotation looks like: that
// refresh may happen sooner, but never more than once per kidRefreshInterval
// across all key ids. A key id that a refresh did not return is remembered
// for keyRefreshInterval and does not trigger another one.
const (
	keyRefreshInterval = time.Minute
	kidRefreshInterval = 5 * time.Second
	// maxUnknownKids bounds the negative cache: key ids come from unauthenticated tokens.
	maxUnknownKids = 1024
	// maxJWKSBytes bounds the key set document read from the identity provider.
	maxJWKSBytes = 1 << 20
)

// errRefreshThrottled is returned when no cached key verifies a token and the
// policy above does not allow fetching the key set again yet.
var errRefreshThrottled = errors.New("no matching key and key set refresh throttled")

// keySet is an oidc.KeySet over the issuer's jwks_uri with a bounded refresh rate.
type keySet struct {
	jwksURL string
	client  *http.Client
	algs    []jose.SignatureAlgorithm
	now     func() time.Time

	mu        sync.Mutex
	keys      []jose.JSONWebKey
	lastFetch time.Time            // start of the last fetch, successful or not
	unknown   map[string]time.Time // key id → until when a refresh for it is not allowed
	inflight  *fetchCall
}

// fetchCall is one remote fetch, shared by every verification that waits for it.
type fetchCall struct {
	done chan struct{}
	keys []jose.JSONWebKey
	err  error
}

func newKeySet(jwksURL string, client *http.Client, algs []string) *keySet {
	ks := &keySet{jwksURL: jwksURL, client: client, now: time.Now, unknown: map[string]time.Time{}}
	for _, a := range algs {
		ks.algs = append(ks.algs, jose.SignatureAlgorithm(a))
	}
	return ks
}

// VerifySignature implements oidc.KeySet. The verifier has already checked
// the algorithm; the token is parsed again with the same allow-list.
func (s *keySet) VerifySignature(ctx context.Context, raw string) ([]byte, error) {
	jws, err := jose.ParseSigned(raw, s.algs)
	if err != nil {
		return nil, fmt.Errorf("malformed jwt: %w", err)
	}
	if len(jws.Signatures) != 1 {
		return nil, errors.New("expected exactly one signature")
	}
	kid := jws.Signatures[0].Header.KeyID
	s.mu.Lock()
	keys := s.keys
	s.mu.Unlock()
	if payload, ok := verifyWith(jws, kid, keys); ok {
		return payload, nil
	}
	keys, err = s.refresh(ctx, kid)
	if err != nil {
		return nil, err
	}
	if payload, ok := verifyWith(jws, kid, keys); ok {
		return payload, nil
	}
	return nil, errors.New("no key of the issuer verifies the signature")
}

func verifyWith(jws *jose.JSONWebSignature, kid string, keys []jose.JSONWebKey) ([]byte, bool) {
	for i := range keys {
		if kid != "" && keys[i].KeyID != kid {
			continue
		}
		if payload, err := jws.Verify(&keys[i]); err == nil {
			return payload, true
		}
	}
	return nil, false
}

// refresh fetches the key set if the policy allows it (or joins the fetch in
// progress) and returns the keys it brought.
func (s *keySet) refresh(ctx context.Context, kid string) ([]jose.JSONWebKey, error) {
	s.mu.Lock()
	call := s.inflight
	if call == nil {
		now := s.now()
		since := now.Sub(s.lastFetch)
		if since < keyRefreshInterval && (since < kidRefreshInterval || !s.neverSeen(kid, now)) {
			s.mu.Unlock()
			return nil, errRefreshThrottled
		}
		s.lastFetch = now
		call = &fetchCall{done: make(chan struct{})}
		s.inflight = call
		go s.fetch(call)
	}
	s.mu.Unlock()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-call.done:
	}
	if call.err != nil {
		return nil, call.err
	}
	if kid != "" && !hasKid(call.keys, kid) {
		s.forget(kid)
	}
	return call.keys, nil
}

// neverSeen reports whether kid is neither a cached key nor a recent miss. Called with mu held.
func (s *keySet) neverSeen(kid string, now time.Time) bool {
	if kid == "" || hasKid(s.keys, kid) {
		return false
	}
	until, ok := s.unknown[kid]
	return !ok || now.After(until)
}

// forget records that the issuer does not publish kid.
func (s *keySet) forget(kid string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if len(s.unknown) >= maxUnknownKids {
		for k, until := range s.unknown {
			if now.After(until) {
				delete(s.unknown, k)
			}
		}
		if len(s.unknown) >= maxUnknownKids {
			return // the global refresh interval still bounds the fetches
		}
	}
	s.unknown[kid] = now.Add(keyRefreshInterval)
}

func hasKid(keys []jose.JSONWebKey, kid string) bool {
	for i := range keys {
		if keys[i].KeyID == kid {
			return true
		}
	}
	return false
}

// fetch runs one remote fetch. It does not depend on the context of the
// verification that started it: the HTTP client's timeout bounds it, so a
// stalled identity provider cannot hold the in-flight call forever.
func (s *keySet) fetch(call *fetchCall) {
	call.keys, call.err = s.download()
	s.mu.Lock()
	if call.err == nil {
		s.keys = call.keys
	}
	s.inflight = nil
	s.mu.Unlock()
	close(call.done)
}

func (s *keySet) download() ([]jose.JSONWebKey, error) {
	req, err := http.NewRequest(http.MethodGet, s.jwksURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Cache-Control", "no-cache")
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch jwks: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxJWKSBytes))
	if err != nil {
		return nil, fmt.Errorf("fetch jwks: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetch jwks: %s", resp.Status)
	}
	return parseJWKS(body)
}

// parseJWKS decodes a key set, skipping the keys that cannot sign tokens here
// (encryption keys, unsupported key types), as go-oidc does: one such key
// must not make the whole set unusable.
func parseJWKS(body []byte) ([]jose.JSONWebKey, error) {
	var raw struct {
		Keys []json.RawMessage `json:"keys"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("decode jwks: %w", err)
	}
	keys := make([]jose.JSONWebKey, 0, len(raw.Keys))
	for _, k := range raw.Keys {
		var jwk jose.JSONWebKey
		if err := json.Unmarshal(k, &jwk); err != nil || jwk.Use == "enc" || !jwk.Valid() || !jwk.IsPublic() {
			continue
		}
		keys = append(keys, jwk)
	}
	return keys, nil
}
