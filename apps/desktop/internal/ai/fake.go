package ai

import (
	"context"
	"sync"
)

// Fake is the provider of the tests: it answers with the chunks it was given, without any network.
// The application's own tests use it through Options.Provider.
type Fake struct {
	// Chunks are yielded in order.
	Chunks []string
	// Err is returned after the chunks (nil = the answer is complete).
	Err error
	// Hold, when set, blocks the stream after the first chunk until it is closed or the request is
	// cancelled: a request that is still running.
	Hold <-chan struct{}

	mu      sync.Mutex
	prompts []Prompt
}

// Stream implements Provider.
func (f *Fake) Stream(ctx context.Context, p Prompt, yield func(string) error) error {
	f.mu.Lock()
	f.prompts = append(f.prompts, p)
	f.mu.Unlock()
	for i, c := range f.Chunks {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := yield(c); err != nil {
			return err
		}
		if i == 0 && f.Hold != nil {
			select {
			case <-f.Hold:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	}
	return f.Err
}

// Prompts returns the prompts the provider received (a copy).
func (f *Fake) Prompts() []Prompt {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Prompt(nil), f.prompts...)
}
