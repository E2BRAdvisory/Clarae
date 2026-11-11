package ai

import (
	"context"
	"encoding/json"
	"net/http"
)

// OpenAI streams from /v1/chat/completions: OpenAI itself and every server that speaks its protocol
// (a local Ollama, a gateway of the company).
type OpenAI struct {
	BaseURL string // root of the API, without a trailing slash
	Model   string
	APIKey  string // may be empty for a server on this machine
	Client  *http.Client
}

type openAIChunk struct {
	Choices []struct {
		Delta struct {
			Content string `json:"content"`
		} `json:"delta"`
	} `json:"choices"`
	Error *struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	} `json:"error"`
}

// Stream implements Provider.
func (o OpenAI) Stream(ctx context.Context, p Prompt, yield func(string) error) error {
	headers := map[string]string{}
	if o.APIKey != "" {
		headers["Authorization"] = "Bearer " + o.APIKey
	}
	resp, err := post(ctx, o.Client, o.BaseURL+"/v1/chat/completions", o.APIKey, headers, map[string]any{
		"model":  o.Model,
		"stream": true,
		"messages": []map[string]string{
			{"role": "system", "content": DefaultSystemPrompt},
			{"role": "user", "content": UserMessage(p)},
		},
	})
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	err = readSSE(resp.Body, func(payload string) (bool, error) {
		if payload == "[DONE]" {
			return true, nil
		}
		var ev openAIChunk
		if json.Unmarshal([]byte(payload), &ev) != nil {
			return false, nil // a line that is not JSON (a keep-alive) says nothing
		}
		if ev.Error != nil {
			return true, providerError(ev.Error.Type, ev.Error.Message, o.APIKey)
		}
		if len(ev.Choices) > 0 && ev.Choices[0].Delta.Content != "" {
			return false, yield(ev.Choices[0].Delta.Content)
		}
		return false, nil
	})
	return streamErr(ctx, err, o.APIKey)
}

// streamErr reports a cancelled context as such, whatever the body reader made of it.
func streamErr(ctx context.Context, err error, key string) error {
	if err != nil && ctx.Err() != nil {
		return ctx.Err()
	}
	return redact(err, key)
}
