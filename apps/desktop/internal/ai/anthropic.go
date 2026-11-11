package ai

import (
	"context"
	"encoding/json"
	"net/http"
)

// anthropicVersion is the `anthropic-version` header of the API this client was written against.
const anthropicVersion = "2023-06-01"

// Anthropic streams from /v1/messages.
type Anthropic struct {
	BaseURL   string // root of the API, without a trailing slash
	Model     string
	APIKey    string
	MaxTokens int // 0 = 4096
	Client    *http.Client
}

type anthropicEvent struct {
	Type  string `json:"type"`
	Delta struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"delta"`
	Error *struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	} `json:"error"`
}

// Stream implements Provider.
func (a Anthropic) Stream(ctx context.Context, p Prompt, yield func(string) error) error {
	maxTokens := a.MaxTokens
	if maxTokens <= 0 {
		maxTokens = defaultMaxTokens
	}
	headers := map[string]string{"anthropic-version": anthropicVersion}
	if a.APIKey != "" {
		headers["x-api-key"] = a.APIKey
	}
	resp, err := post(ctx, a.Client, a.BaseURL+"/v1/messages", a.APIKey, headers, map[string]any{
		"model":      a.Model,
		"max_tokens": maxTokens,
		"stream":     true,
		"system":     DefaultSystemPrompt,
		"messages":   []map[string]string{{"role": "user", "content": UserMessage(p)}},
	})
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	err = readSSE(resp.Body, func(payload string) (bool, error) {
		var ev anthropicEvent
		if json.Unmarshal([]byte(payload), &ev) != nil {
			return false, nil
		}
		switch {
		case ev.Type == "error" && ev.Error != nil:
			return true, providerError(ev.Error.Type, ev.Error.Message, a.APIKey)
		case ev.Type == "content_block_delta" && ev.Delta.Type == "text_delta" && ev.Delta.Text != "":
			return false, yield(ev.Delta.Text)
		case ev.Type == "message_stop":
			return true, nil
		}
		return false, nil
	})
	return streamErr(ctx, err, a.APIKey)
}
