package vault

import (
	"testing"
	"time"
)

// The change callback runs outside the locks of the settings: it may read them, and it hears of every
// operation (the browser build learns of its own writes this way).
func TestConfigCallbacksMayCallBack(t *testing.T) {
	fs := newTestFS(t)
	var heard []string
	fs.SetOnChange(func(p []string) {
		heard = append(heard, p...)
		_, _ = fs.ReadConfig("editor.json")
		_, _ = fs.ConfigPath("editor.json")
	})
	put(t, fs, cfgLegacy+"/editor.json", "x")
	put(t, fs, cfgCurrent+"/hotkeys.json", "y")
	done := make(chan struct{})
	go func() {
		defer close(done)
		if _, err := fs.WriteConfig("editor.json", []byte("z"), "", false); err != nil {
			t.Error(err)
		}
		if _, moved, err := fs.MoveConfig(cfgLegacy+"/editor.json", ""); err != nil || !moved {
			t.Errorf("move: %v %v", moved, err)
		}
		put(t, fs, cfgCurrent+"/appearance.json", "{}")
		if n, err := fs.ShelveConfig(); err != nil || n != 3 {
			t.Errorf("shelve: %d %v", n, err)
		}
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("deadlock: a change callback that reads a setting never returned")
	}
	if len(heard) < 4 {
		t.Fatalf("the callback heard %v", heard)
	}
}
