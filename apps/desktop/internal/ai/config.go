package ai

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// ConfigFile is the file of the data directory that names the provider (next to the application
// database, outside every vault: a vault is shared and synced, the provider is the user's own). It
// never holds the key, which lives in the keychain (SetKey).
const ConfigFile = "ai.json"

// maxConfigBytes bounds the file that is read.
const maxConfigBytes = 64 << 10

// The kinds of provider.
const (
	KindOpenAI    = "openai"    // OpenAI and every server that speaks its /v1/chat/completions
	KindAnthropic = "anthropic" // Anthropic's /v1/messages
)

// Config says which model answers and where it is.
type Config struct {
	// Provider is KindOpenAI or KindAnthropic.
	Provider string `json:"provider"`
	// BaseURL is the root of the API (without /v1, which the client adds); empty means the provider's
	// own. It must be https, or http on the machine itself (a local server): the key and the text
	// never travel in the clear.
	BaseURL string `json:"baseUrl,omitempty"`
	// Model is the identifier of the model.
	Model string `json:"model"`
	// MaxTokens bounds an answer of Anthropic (0 = 4096).
	MaxTokens int `json:"maxTokens,omitempty"`
}

// Defaults of the endpoints.
const (
	defaultOpenAIURL    = "https://api.openai.com"
	defaultAnthropicURL = "https://api.anthropic.com"
	defaultMaxTokens    = 4096
	maxMaxTokens        = 64000
)

// LoadConfig reads and validates the provider settings of dataDir. A missing file (or an empty
// dataDir) is ErrNotConfigured; a file that is not valid is an error that says why.
func LoadConfig(dataDir string) (Config, error) {
	if dataDir == "" {
		return Config{}, ErrNotConfigured
	}
	f, err := os.Open(filepath.Join(dataDir, ConfigFile))
	if errors.Is(err, os.ErrNotExist) {
		return Config{}, ErrNotConfigured
	}
	if err != nil {
		return Config{}, fmt.Errorf("%w: %w", ErrNotConfigured, err)
	}
	defer func() { _ = f.Close() }()
	raw, err := io.ReadAll(io.LimitReader(f, maxConfigBytes+1))
	if err != nil {
		return Config{}, fmt.Errorf("%w: %w", ErrNotConfigured, err)
	}
	if len(raw) > maxConfigBytes {
		return Config{}, fmt.Errorf("%w: %s is larger than %d bytes", ErrNotConfigured, ConfigFile, maxConfigBytes)
	}
	var c Config
	if err := json.Unmarshal(raw, &c); err != nil {
		return Config{}, fmt.Errorf("%w: %s: %w", ErrNotConfigured, ConfigFile, err)
	}
	return c.Normalize()
}

// Normalize validates the settings and fills in the defaults.
func (c Config) Normalize() (Config, error) {
	c.Provider = strings.ToLower(strings.TrimSpace(c.Provider))
	c.Model = strings.TrimSpace(c.Model)
	switch c.Provider {
	case KindOpenAI, KindAnthropic:
	default:
		return Config{}, fmt.Errorf("%w: provider must be %q or %q", ErrNotConfigured, KindOpenAI, KindAnthropic)
	}
	if c.Model == "" || len(c.Model) > 200 || strings.ContainsFunc(c.Model, isControl) {
		return Config{}, fmt.Errorf("%w: model is missing or not valid", ErrNotConfigured)
	}
	if c.BaseURL == "" {
		c.BaseURL = defaultOpenAIURL
		if c.Provider == KindAnthropic {
			c.BaseURL = defaultAnthropicURL
		}
	}
	base, err := cleanBaseURL(c.BaseURL)
	if err != nil {
		return Config{}, fmt.Errorf("%w: %w", ErrNotConfigured, err)
	}
	c.BaseURL = base
	if c.MaxTokens < 0 || c.MaxTokens > maxMaxTokens {
		return Config{}, fmt.Errorf("%w: maxTokens must be between 1 and %d", ErrNotConfigured, maxMaxTokens)
	}
	if c.MaxTokens == 0 {
		c.MaxTokens = defaultMaxTokens
	}
	return c, nil
}

// NeedsKey reports whether the provider wants a key: every remote one does; a server on this machine
// (Ollama, llama.cpp) may go without.
func (c Config) NeedsKey() bool { return !isLoopbackURL(c.BaseURL) }

// cleanBaseURL accepts https URLs, and http ones only for the loopback interface, without
// credentials, query or fragment, and returns it without the trailing slashes.
func cleanBaseURL(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" {
		return "", errors.New("baseUrl is not a URL")
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("baseUrl must not carry credentials, a query or a fragment")
	}
	switch u.Scheme {
	case "https":
	case "http":
		if !isLoopbackHost(u.Hostname()) {
			return "", errors.New("baseUrl must be https (http is accepted for the local machine only)")
		}
	default:
		return "", errors.New("baseUrl must be an https URL")
	}
	return strings.TrimRight(u.String(), "/"), nil
}

func isLoopbackURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && isLoopbackHost(u.Hostname())
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func isControl(r rune) bool { return r < 0x20 || r == 0x7f }

// ValidateKey checks a key before it is stored: printable, without spaces, of a sensible size. A key
// goes into an HTTP header, so a line break in it would let it inject headers.
func ValidateKey(key string) error {
	if key == "" || len(key) > 4096 {
		return fmt.Errorf("%w: the key must have between 1 and 4096 characters", ErrInvalid)
	}
	if strings.ContainsFunc(key, func(r rune) bool { return isControl(r) || r == ' ' || r > 0x7e }) {
		return fmt.Errorf("%w: the key must be printable ASCII without spaces", ErrInvalid)
	}
	return nil
}
