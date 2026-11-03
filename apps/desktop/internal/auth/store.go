package auth

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

// persisted is the non-secret part of the session (<dataDir>/auth.json).
type persisted struct {
	ServerURL    string `json:"server_url"`
	Issuer       string `json:"issuer"`
	ClientID     string `json:"client_id"`
	Audience     string `json:"audience"`
	GRPCEndpoint string `json:"grpc_endpoint"`
	DeviceID     string `json:"device_id"`
	// DeviceRevoked: the cloud refused DeviceID as revoked; the session stays
	// signed in but does not sync until ReregisterDevice replaces the device.
	DeviceRevoked bool    `json:"device_revoked,omitempty"`
	Profile       Profile `json:"profile"`
}

const sessionFile = "auth.json"

func sessionPath(dataDir string) string { return filepath.Join(dataDir, sessionFile) }

func saveSession(dataDir string, p *persisted) error {
	data, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return err
	}
	tmp := sessionPath(dataDir) + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, sessionPath(dataDir))
}

func loadSession(dataDir string) (*persisted, error) { return readSession(dataDir, true) }

// readSession reads auth.json; oidc says whether the OIDC endpoints are required (a hosted session
// keeps only the server and the device registration).
func readSession(dataDir string, oidc bool) (*persisted, error) {
	data, err := os.ReadFile(sessionPath(dataDir))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var p persisted
	if err := json.Unmarshal(data, &p); err != nil {
		return nil, err
	}
	if p.ServerURL == "" || oidc && (p.Issuer == "" || p.ClientID == "") {
		return nil, errors.New("incomplete session file")
	}
	return &p, nil
}

func deleteSession(dataDir string) error {
	err := os.Remove(sessionPath(dataDir))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

// SecretStore keeps the refresh token per server.
type SecretStore interface {
	Set(server, refreshToken string) error
	Get(server string) (string, error)
	Delete(server string) error
}

// MemoryStore is an in-memory SecretStore for tests and headless environments.
type MemoryStore struct{ m map[string]string }

// NewMemoryStore returns an empty store.
func NewMemoryStore() *MemoryStore { return &MemoryStore{m: map[string]string{}} }

// Set implements SecretStore.
func (s *MemoryStore) Set(server, v string) error { s.m[server] = v; return nil }

// Get implements SecretStore.
func (s *MemoryStore) Get(server string) (string, error) { return s.m[server], nil }

// Delete implements SecretStore.
func (s *MemoryStore) Delete(server string) error { delete(s.m, server); return nil }
