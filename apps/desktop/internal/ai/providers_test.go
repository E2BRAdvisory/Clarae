//go:build !js

package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"unicode/utf8"
)

func collect(p Provider, prompt Prompt) (string, error) {
	var b strings.Builder
	err := p.Stream(context.Background(), prompt, func(s string) error { b.WriteString(s); return nil })
	return b.String(), err
}

func TestOpenAIStreamsDeltas(t *testing.T) {
	var gotAuth, gotPath, gotCT string
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth, gotPath, gotCT = r.Header.Get("Authorization"), r.URL.Path, r.Header.Get("Content-Type")
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "text/event-stream")
		// CRLF line ends, a comment, an event name, a keep-alive that is not JSON, a role-only delta, and
		// a stream that stops at [DONE] with more after it.
		_, _ = fmt.Fprint(w, ": keep-alive\r\n\r\n"+
			"event: message\r\ndata: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\r\n\r\n"+
			"data: not json\r\n\r\n"+
			"data:{\"choices\":[{\"delta\":{\"content\":\" Hel\"}}]}\r\n\r\n"+
			"data: {\"choices\":[{\"delta\":{\"content\":\"lo \\n\"}}]}\r\n\r\n"+
			"data: [DONE]\r\n\r\n"+
			"data: {\"choices\":[{\"delta\":{\"content\":\"AFTER\"}}]}\r\n\r\n")
	}))
	defer srv.Close()
	got, err := collect(OpenAI{BaseURL: srv.URL, Model: "gpt-x", APIKey: "sk-secret"}, Prompt{Document: "doc", Selection: "sel", Instruction: "ins"})
	if err != nil {
		t.Fatal(err)
	}
	if got != " Hello \n" {
		t.Fatalf("streamed %q (whitespace of the tokens is part of the text)", got)
	}
	if gotAuth != "Bearer sk-secret" || gotPath != "/v1/chat/completions" || gotCT != "application/json" {
		t.Fatalf("auth %q path %q type %q", gotAuth, gotPath, gotCT)
	}
	msgs, _ := body["messages"].([]any)
	if body["model"] != "gpt-x" || body["stream"] != true || len(msgs) != 2 {
		t.Fatalf("body = %v", body)
	}
	if sys := msgs[0].(map[string]any); sys["role"] != "system" || sys["content"] != DefaultSystemPrompt {
		t.Fatalf("system message = %v", sys)
	}
	if u := msgs[1].(map[string]any); u["role"] != "user" || u["content"] != "<document>\ndoc\n</document>\n\n<selection>\nsel\n</selection>\n\n<instruction>\nins\n</instruction>" {
		t.Fatalf("user message = %v", u)
	}
}

func TestOpenAIWithoutKeyAndWithoutSelection(t *testing.T) {
	var auth []string
	var user string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Values("Authorization")
		var b struct{ Messages []struct{ Content string } }
		_ = json.NewDecoder(r.Body).Decode(&b)
		user = b.Messages[1].Content
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n")
	}))
	defer srv.Close()
	if got, err := collect(OpenAI{BaseURL: srv.URL, Model: "local"}, Prompt{Document: "d", Instruction: "i"}); err != nil || got != "ok" {
		t.Fatalf("%q, %v (a stream that ends without [DONE] is complete)", got, err)
	}
	if len(auth) != 0 {
		t.Errorf("an Authorization header was sent without a key: %v", auth)
	}
	if strings.Contains(user, "<selection>") {
		t.Errorf("an empty selection is not sent: %q", user)
	}
}

func TestAnthropicStreamsTextDeltas(t *testing.T) {
	var hdr http.Header
	var gotPath string
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hdr, gotPath = r.Header.Clone(), r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, _ = fmt.Fprint(w, "event: message_start\ndata: {\"type\":\"message_start\"}\n\n"+
			"event: content_block_start\ndata: {\"type\":\"content_block_start\"}\n\n"+
			"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Bon\"}}\n\n"+
			"event: ping\ndata: {\"type\":\"ping\"}\n\n"+
			"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"input_json_delta\",\"text\":\"IGNORED\"}}\n\n"+
			"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\" jour\"}}\n\n"+
			"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"+
			"data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"AFTER\"}}\n\n")
	}))
	defer srv.Close()
	got, err := collect(Anthropic{BaseURL: srv.URL, Model: "claude-x", APIKey: "ak-secret", MaxTokens: 123}, Prompt{Document: "d", Instruction: "i"})
	if err != nil || got != "Bon jour" {
		t.Fatalf("%q, %v", got, err)
	}
	if hdr.Get("x-api-key") != "ak-secret" || hdr.Get("anthropic-version") != "2023-06-01" || gotPath != "/v1/messages" {
		t.Fatalf("headers %v path %q", hdr, gotPath)
	}
	if hdr.Get("Authorization") != "" {
		t.Errorf("Authorization sent to Anthropic: %q", hdr.Get("Authorization"))
	}
	msgs, _ := body["messages"].([]any)
	if body["system"] != DefaultSystemPrompt || body["max_tokens"] != float64(123) || body["stream"] != true || len(msgs) != 1 {
		t.Fatalf("body = %v", body)
	}
}

func TestAnthropicDefaultMaxTokens(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, _ = fmt.Fprint(w, "data: {\"type\":\"message_stop\"}\n\n")
	}))
	defer srv.Close()
	if _, err := collect(Anthropic{BaseURL: srv.URL, Model: "m", APIKey: "k"}, Prompt{Instruction: "i"}); err != nil {
		t.Fatal(err)
	}
	if body["max_tokens"] != float64(4096) {
		t.Fatalf("max_tokens = %v", body["max_tokens"])
	}
}

// An error status is an error that quotes the start of the body, and never the key (a server may echo it).
func TestProviderHTTPErrorsDoNotLeakTheKey(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = fmt.Fprint(w, "Incorrect API key provided: sk-secret-key.\n"+strings.Repeat("y", 5000))
	}))
	defer srv.Close()
	for name, p := range map[string]Provider{
		"openai":    OpenAI{BaseURL: srv.URL, Model: "m", APIKey: "sk-secret-key"},
		"anthropic": Anthropic{BaseURL: srv.URL, Model: "m", APIKey: "sk-secret-key"},
	} {
		_, err := collect(p, Prompt{Instruction: "i"})
		if err == nil || !strings.Contains(err.Error(), "HTTP 401") {
			t.Fatalf("%s: %v", name, err)
		}
		if strings.Contains(err.Error(), "sk-secret-key") || len(err.Error()) > 700 || strings.ContainsAny(err.Error(), "\n\r") {
			t.Errorf("%s: the error leaks the key, is unbounded or has line breaks: %q", name, err)
		}
	}
}

// A key straddling the byte where the quote is cut must not appear half-visible: it is removed
// before the cut (HTTP error bodies and error events alike).
func TestKeyAcrossTheCutIsRedacted(t *testing.T) {
	const key = "sk-secret-key-0123456789"
	for _, at := range []int{maxErrorBody - len(key) + 1, maxErrorBody - 1, maxErrorBody - len(key)/2} {
		text := strings.Repeat("y", at) + key + strings.Repeat("z", 100)
		srvHTTP := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusBadGateway)
			_, _ = fmt.Fprint(w, text)
		}))
		srvEvent := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			raw, _ := json.Marshal(map[string]any{"error": map[string]any{"type": "server_error", "message": text}})
			_, _ = fmt.Fprintf(w, "data: %s\n\n", raw)
		}))
		for name, srv := range map[string]*httptest.Server{"http": srvHTTP, "event": srvEvent} {
			_, err := collect(OpenAI{BaseURL: srv.URL, Model: "m", APIKey: key}, Prompt{Instruction: "i"})
			if err == nil {
				t.Fatalf("%s at %d: no error", name, at)
			}
			// No prefix of the key of 4 characters or more is left (the text before it is only "y").
			for n := 4; n <= len(key); n++ {
				if strings.Contains(err.Error(), key[:n]) {
					t.Errorf("%s at %d: the error shows %q of the key: %q", name, at, key[:n], err)
					break
				}
			}
		}
		srvHTTP.Close()
		srvEvent.Close()
	}
}

// The reader cuts the body a key's length past the quoted limit; when the text shrinks before the
// cut (the key replaced by ***, leading spaces trimmed), the half-read key at the tail must not
// become visible.
func TestKeyPrefixAtTheReadTailIsNotShownAfterTheTextShrinks(t *testing.T) {
	const key = "sk-secret-key-0123456789"
	bodies := map[string]string{
		"echoed key then straddling key": key + strings.Repeat("y", 505-len(key)) + key + strings.Repeat("z", 100),
		"leading spaces then straddling": strings.Repeat(" ", 100) + strings.Repeat("y", 410) + key + strings.Repeat("z", 100),
	}
	for name, body := range bodies {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusBadGateway)
			_, _ = fmt.Fprint(w, body)
		}))
		_, err := collect(OpenAI{BaseURL: srv.URL, Model: "m", APIKey: key}, Prompt{Instruction: "i"})
		srv.Close()
		if err == nil {
			t.Fatalf("%s: no error", name)
		}
		for n := 4; n <= len(key); n++ {
			if strings.Contains(err.Error(), key[:n]) {
				t.Errorf("%s: the error shows %q of the key: %q", name, key[:n], err)
				break
			}
		}
	}
}

// A text that is not cut keeps what looks like the beginning of the key.
func TestQuoteReadKeepsATailOfAnUncutText(t *testing.T) {
	if got := quoteRead("see sk-sec", "sk-secret", false); got != "see sk-sec" {
		t.Fatalf("got %q", got)
	}
	if got := quoteRead("see sk-sec", "sk-secret", true); got != "see" {
		t.Fatalf("got %q", got)
	}
}

// The cut keeps the text valid UTF-8.
func TestQuoteCutsOnARuneBoundary(t *testing.T) {
	got := quote(strings.Repeat("a", maxErrorBody-1)+"\u00e8\u00e8", "k")
	if !utf8.ValidString(got) || len(got) > maxErrorBody {
		t.Fatalf("%d bytes, valid=%v", len(got), utf8.ValidString(got))
	}
}

func TestProviderErrorEventInTheStream(t *testing.T) {
	srvO := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\n\ndata: {\"error\":{\"type\":\"server_error\",\"message\":\"overloaded sk-k\"}}\n\n")
	}))
	defer srvO.Close()
	got, err := collect(OpenAI{BaseURL: srvO.URL, Model: "m", APIKey: "sk-k"}, Prompt{Instruction: "i"})
	if got != "a" || err == nil || !strings.Contains(err.Error(), "server_error: overloaded ***") {
		t.Fatalf("%q, %v", got, err)
	}
	srvA := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = fmt.Fprint(w, "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}\n\n")
	}))
	defer srvA.Close()
	if _, err := collect(Anthropic{BaseURL: srvA.URL, Model: "m", APIKey: "k"}, Prompt{Instruction: "i"}); err == nil || !strings.Contains(err.Error(), "overloaded_error: Overloaded") {
		t.Fatalf("%v", err)
	}
}

// A redirect is not followed: the key must not go to another host (x-api-key survives a cross-host
// redirect in net/http).
func TestProvidersDoNotFollowRedirects(t *testing.T) {
	var elsewhere int
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { elsewhere++ }))
	defer other.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+"/v1/messages", http.StatusTemporaryRedirect)
	}))
	defer srv.Close()
	// A client of the caller, which follows redirects by default, is copied without that rule.
	for name, p := range map[string]Provider{
		"openai":    OpenAI{BaseURL: srv.URL, Model: "m", APIKey: "k", Client: &http.Client{}},
		"anthropic": Anthropic{BaseURL: srv.URL, Model: "m", APIKey: "k", Client: &http.Client{}},
	} {
		if _, err := collect(p, Prompt{Instruction: "i"}); err == nil || !strings.Contains(err.Error(), "HTTP 307") {
			t.Fatalf("%s: %v", name, err)
		}
	}
	if elsewhere != 0 {
		t.Fatalf("the redirect was followed %d times", elsewhere)
	}
}

// Hostile streams: a line without end, an endless response.
func TestHostileStreams(t *testing.T) {
	long := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = fmt.Fprint(w, "data: "+strings.Repeat("a", maxSSELine+10))
	}))
	defer long.Close()
	if _, err := collect(OpenAI{BaseURL: long.URL, Model: "m"}, Prompt{Instruction: "i"}); !errors.Is(err, errSSELineTooLong) {
		t.Fatalf("a line over the limit: %v", err)
	}

	endless := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		line := ": " + strings.Repeat("k", 4000) + "\n"
		for range maxStreamSize/len(line) + 100 {
			if _, err := io.WriteString(w, line); err != nil {
				return
			}
		}
	}))
	defer endless.Close()
	if _, err := collect(OpenAI{BaseURL: endless.URL, Model: "m"}, Prompt{Instruction: "i"}); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("an endless response: %v, want ErrTooLarge", err)
	}
}

// A cancelled context ends a provider with the context's error, not with a transport message.
func TestProviderHonoursTheContext(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := OpenAI{BaseURL: srv.URL, Model: "m"}.Stream(ctx, Prompt{Instruction: "i"}, func(string) error { return nil })
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
}
