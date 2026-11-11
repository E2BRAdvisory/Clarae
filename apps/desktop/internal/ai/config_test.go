package ai

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadSSEKeepsTheLastLineWithoutNewline(t *testing.T) {
	var got []string
	err := readSSE(strings.NewReader("data: a\ndata: b\r\ndata:c"), func(p string) (bool, error) { got = append(got, p); return false, nil })
	if err != nil || strings.Join(got, "|") != "a|b|c" {
		t.Fatalf("%v, %v", got, err)
	}
}

func TestConfig(t *testing.T) {
	dir := t.TempDir()
	write := func(s string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, ConfigFile), []byte(s), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := LoadConfig(dir); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("no file: %v", err)
	}
	if _, err := LoadConfig(""); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("no directory: %v", err)
	}
	write(`{"provider":"Anthropic","model":" claude-x "}`)
	c, err := LoadConfig(dir)
	if err != nil || c.Provider != KindAnthropic || c.Model != "claude-x" || c.BaseURL != "https://api.anthropic.com" || c.MaxTokens != 4096 || !c.NeedsKey() {
		t.Fatalf("%+v, %v", c, err)
	}
	write(`{"provider":"openai","model":"llama3","baseUrl":"http://localhost:11434/"}`)
	c, err = LoadConfig(dir)
	if err != nil || c.BaseURL != "http://localhost:11434" || c.NeedsKey() {
		t.Fatalf("a local server needs no key: %+v, %v", c, err)
	}
	write(`{"provider":"openai","model":"m","baseUrl":"https://gw.example.com/openai/"}`)
	if c, err = LoadConfig(dir); err != nil || c.BaseURL != "https://gw.example.com/openai" || !c.NeedsKey() {
		t.Fatalf("%+v, %v", c, err)
	}
	for name, bad := range map[string]string{ //nolint:gosec // invalid configs under test, no real credentials
		"not json":         `{`,
		"unknown kind":     `{"provider":"gemini","model":"m"}`,
		"no model":         `{"provider":"openai"}`,
		"control in model": "{\"provider\":\"openai\",\"model\":\"a\\nb\"}",
		"plain http":       `{"provider":"openai","model":"m","baseUrl":"http://api.example.com"}`,
		"credentials":      `{"provider":"openai","model":"m","baseUrl":"https://u:p@api.example.com"}`,
		"query":            `{"provider":"openai","model":"m","baseUrl":"https://api.example.com/?k=v"}`,
		"scheme":           `{"provider":"openai","model":"m","baseUrl":"file:///etc/passwd"}`,
		"no host":          `{"provider":"openai","model":"m","baseUrl":"https:///x"}`,
		"tokens":           `{"provider":"anthropic","model":"m","maxTokens":-1}`,
		"huge tokens":      `{"provider":"anthropic","model":"m","maxTokens":9999999}`,
		"lookalike host":   `{"provider":"openai","model":"m","baseUrl":"http://localhost.evil.com"}`,
	} {
		write(bad)
		if _, err := LoadConfig(dir); !errors.Is(err, ErrNotConfigured) {
			t.Errorf("%s: %v, want ErrNotConfigured", name, err)
		}
	}
	write(strings.Repeat(" ", maxConfigBytes+1))
	if _, err := LoadConfig(dir); !errors.Is(err, ErrNotConfigured) {
		t.Errorf("a file over the limit: %v", err)
	}
}
