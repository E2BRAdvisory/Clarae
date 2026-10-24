package auth

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"github.com/zalando/go-keyring"
)

// persisted is the non-secret part of the session (<dataDir>/auth.json).
type persisted struct {
	ServerURL    string  `json:"server_url"`
	Issuer       string  `json:"issuer"`
	ClientID     string  `json:"client_id"`
	Audience     string  `json:"audience"`
	GRPCEndpoint string  `json:"grpc_endpoint"`
	DeviceID     string  `json:"device_id"`
	Profile      Profile `json:"profile"`
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

func loadSession(dataDir string) (*persisted, error) {
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
	if p.ServerURL == "" || p.Issuer == "" || p.ClientID == "" {
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

// KeychainStore uses the OS keychain (macOS Keychain, Windows Credential
// Manager, freedesktop Secret Service) via go-keyring (§2.5 "auth").
type KeychainStore struct{}

const keychainService = "Nodus"

// Set implements SecretStore.
func (KeychainStore) Set(server, refreshToken string) error {
	return keyring.Set(keychainService, "refresh-token:"+server, refreshToken)
}

// Get implements SecretStore; a missing entry yields "" and no error.
func (KeychainStore) Get(server string) (string, error) {
	v, err := keyring.Get(keychainService, "refresh-token:"+server)
	if errors.Is(err, keyring.ErrNotFound) {
		return "", nil
	}
	return v, err
}

// Delete implements SecretStore.
func (KeychainStore) Delete(server string) error {
	err := keyring.Delete(keychainService, "refresh-token:"+server)
	if errors.Is(err, keyring.ErrNotFound) {
		return nil
	}
	return err
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
