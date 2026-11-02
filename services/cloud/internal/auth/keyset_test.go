package auth

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
)

// jwksServer publishes a mutable key set and counts the fetches.
type jwksServer struct {
	srv     *httptest.Server
	fetches atomic.Int32
	mu      sync.Mutex
	keys    []jose.JSONWebKey
}

func newJWKSServer(t *testing.T) *jwksServer {
	t.Helper()
	s := &jwksServer{}
	s.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		s.fetches.Add(1)
		s.mu.Lock()
		set := jose.JSONWebKeySet{Keys: s.keys}
		s.mu.Unlock()
		_ = json.NewEncoder(w).Encode(set)
	}))
	t.Cleanup(s.srv.Close)
	return s
}

func (s *jwksServer) publish(k *rsa.PrivateKey, kid string) {
	s.mu.Lock()
	s.keys = append(s.keys, jose.JSONWebKey{Key: &k.PublicKey, KeyID: kid, Algorithm: "RS256", Use: "sig"})
	s.mu.Unlock()
}

func rsaKey(t *testing.T) *rsa.PrivateKey {
	t.Helper()
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func signedBy(t *testing.T, k *rsa.PrivateKey, kid string) string {
	t.Helper()
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: k}, (&jose.SignerOptions{}).WithHeader("kid", kid))
	if err != nil {
		t.Fatal(err)
	}
	jws, err := signer.Sign([]byte(`{"sub":"x"}`))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := jws.CompactSerialize()
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// clock is a manual time source.
type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func newTestKeySet(url string, timeout time.Duration) (*keySet, *clock) {
	c := &clock{t: time.Date(2026, 11, 2, 9, 0, 0, 0, time.UTC)}
	ks := newKeySet(url, &http.Client{Timeout: timeout}, signingAlgs)
	ks.now = c.now
	return ks, c
}

// Regression (M12): every token that no cached key verified fetched the key
// set again, so forged tokens drove one JWKS request each to Keycloak.
func TestKeySetBoundsRefreshesForForgedTokens(t *testing.T) {
	srv := newJWKSServer(t)
	real, forger := rsaKey(t), rsaKey(t)
	srv.publish(real, "k1")
	ks, clk := newTestKeySet(srv.srv.URL, time.Second)
	ctx := context.Background()

	if _, err := ks.VerifySignature(ctx, signedBy(t, real, "k1")); err != nil {
		t.Fatal(err)
	}
	if n := srv.fetches.Load(); n != 1 {
		t.Fatalf("cold start fetched %d times, want 1", n)
	}
	// Forged tokens: a known kid with a wrong signature, and many unknown kids.
	for i := range 50 {
		kid := "k1"
		if i%2 == 1 {
			kid = fmt.Sprintf("forged-%d", i)
		}
		if _, err := ks.VerifySignature(ctx, signedBy(t, forger, kid)); err == nil {
			t.Fatal("a forged token verified")
		}
	}
	if n := srv.fetches.Load(); n != 1 {
		t.Fatalf("forged tokens within the kid interval fetched %d times, want 1 in total", n)
	}
	// After the kid interval a never-seen kid may fetch once; the same kid,
	// now known as missing, may not.
	clk.advance(kidRefreshInterval + time.Second)
	_, _ = ks.VerifySignature(ctx, signedBy(t, forger, "never-seen"))
	clk.advance(kidRefreshInterval + time.Second)
	_, _ = ks.VerifySignature(ctx, signedBy(t, forger, "never-seen"))
	_, _ = ks.VerifySignature(ctx, signedBy(t, forger, "k1"))
	if n := srv.fetches.Load(); n != 2 {
		t.Fatalf("fetched %d times, want 2 (one for the new kid, none for the remembered miss)", n)
	}
	// After the refresh interval any miss may refresh again.
	clk.advance(keyRefreshInterval)
	_, _ = ks.VerifySignature(ctx, signedBy(t, forger, "never-seen"))
	if n := srv.fetches.Load(); n != 3 {
		t.Fatalf("fetched %d times after the refresh interval, want 3", n)
	}
	// The genuine key keeps working without fetching.
	if _, err := ks.VerifySignature(ctx, signedBy(t, real, "k1")); err != nil || srv.fetches.Load() != 3 {
		t.Fatalf("genuine token: %v, fetches %d", err, srv.fetches.Load())
	}
}

func TestKeySetPicksUpARotatedKey(t *testing.T) {
	srv := newJWKSServer(t)
	old, rotated := rsaKey(t), rsaKey(t)
	srv.publish(old, "k1")
	ks, clk := newTestKeySet(srv.srv.URL, time.Second)
	ctx := context.Background()
	if _, err := ks.VerifySignature(ctx, signedBy(t, old, "k1")); err != nil {
		t.Fatal(err)
	}
	srv.publish(rotated, "k2")
	clk.advance(kidRefreshInterval)
	if _, err := ks.VerifySignature(ctx, signedBy(t, rotated, "k2")); err != nil {
		t.Fatalf("the token of the new key: %v", err)
	}
	if _, err := ks.VerifySignature(ctx, signedBy(t, old, "k1")); err != nil {
		t.Fatalf("the old key still verifies: %v", err)
	}
	if n := srv.fetches.Load(); n != 2 {
		t.Fatalf("fetched %d times, want 2", n)
	}
}

// A JWKS endpoint that accepts the connection and never answers must not
// hold the verifications: the HTTP client's timeout ends the fetch, and a
// later one can start.
func TestKeySetFetchTimesOut(t *testing.T) {
	release := make(chan struct{})
	hang := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	t.Cleanup(func() { close(release); hang.Close() })
	ks, clk := newTestKeySet(hang.URL, 200*time.Millisecond)
	k := rsaKey(t)
	start := time.Now()
	if _, err := ks.VerifySignature(context.Background(), signedBy(t, k, "k1")); err == nil {
		t.Fatal("verified without keys")
	}
	if took := time.Since(start); took > 5*time.Second {
		t.Fatalf("the fetch took %s", took)
	}
	clk.advance(keyRefreshInterval)
	if _, err := ks.VerifySignature(context.Background(), signedBy(t, k, "k1")); errors.Is(err, errRefreshThrottled) {
		t.Fatal("a failed fetch must not block the next one after the interval")
	}
}

func TestParseJWKSSkipsUnusableKeys(t *testing.T) {
	k := rsaKey(t)
	sig, err := json.Marshal(jose.JSONWebKey{Key: &k.PublicKey, KeyID: "sig", Algorithm: "RS256", Use: "sig"})
	if err != nil {
		t.Fatal(err)
	}
	enc, err := json.Marshal(jose.JSONWebKey{Key: &k.PublicKey, KeyID: "enc", Algorithm: "RSA-OAEP", Use: "enc"})
	if err != nil {
		t.Fatal(err)
	}
	doc := `{"keys":[` + string(sig) + `,` + string(enc) + `,{"kty":"OKP","crv":"X448","x":"AA","kid":"x448"},{"kty":"oct","k":"c2VjcmV0","kid":"hmac"}]}`
	keys, err := parseJWKS([]byte(doc))
	if err != nil {
		t.Fatal(err)
	}
	if len(keys) != 1 || keys[0].KeyID != "sig" {
		t.Fatalf("keys %v, want only the signing key", keys)
	}
}

// Concurrent misses share one fetch, and a verification that gives up (its
// request ended) does not cancel the fetch the others wait for.
func TestKeySetConcurrentMissesShareOneFetch(t *testing.T) {
	release := make(chan struct{})
	var fetches atomic.Int32
	k := rsaKey(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fetches.Add(1)
		<-release
		_ = json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &k.PublicKey, KeyID: "k1", Algorithm: "RS256", Use: "sig"}}})
	}))
	t.Cleanup(srv.Close)
	ks, _ := newTestKeySet(srv.URL, 5*time.Second)
	tok := signedBy(t, k, "k1")

	gaveUp, cancel := context.WithCancel(context.Background())
	abandoned := make(chan error, 1)
	go func() {
		_, err := ks.VerifySignature(gaveUp, tok)
		abandoned <- err
	}()
	const waiters = 20
	errs := make(chan error, waiters)
	for range waiters {
		go func() {
			_, err := ks.VerifySignature(context.Background(), tok)
			errs <- err
		}()
	}
	deadline := time.Now().Add(5 * time.Second)
	for fetches.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	if err := <-abandoned; !errors.Is(err, context.Canceled) {
		t.Fatalf("abandoned verification: %v", err)
	}
	close(release)
	for range waiters {
		if err := <-errs; err != nil {
			t.Fatalf("waiter: %v", err)
		}
	}
	if n := fetches.Load(); n != 1 {
		t.Fatalf("fetched %d times, want 1", n)
	}
}

// The negative cache stays bounded: key ids come from unauthenticated tokens.
func TestKeySetUnknownKidsAreBounded(t *testing.T) {
	ks, clk := newTestKeySet("http://127.0.0.1:0", time.Second)
	for i := range maxUnknownKids + 100 {
		ks.forget(fmt.Sprintf("kid-%d", i))
	}
	if n := len(ks.unknown); n != maxUnknownKids {
		t.Fatalf("negative cache holds %d key ids, want %d", n, maxUnknownKids)
	}
	clk.advance(keyRefreshInterval + time.Second)
	ks.forget("after-expiry")
	if n := len(ks.unknown); n != 1 {
		t.Fatalf("expired key ids kept: %d", n)
	}
}
