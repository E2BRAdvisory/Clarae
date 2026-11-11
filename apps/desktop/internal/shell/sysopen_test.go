//go:build !js

package shell

import (
	"strings"
	"testing"
)

func TestSystemLaunchers(t *testing.T) {
	for _, tt := range []struct {
		goos, name, args string
		reveal           bool
	}{
		{goos: "darwin", name: "open", args: "-- /v/a.zip"},
		{goos: "darwin", name: "open", args: "-R -- /v/a.zip", reveal: true},
		{goos: "windows", name: "rundll32.exe", args: "url.dll,FileProtocolHandler /v/a.zip"},
		{goos: "windows", name: "explorer.exe", args: "/select,/v/a.zip", reveal: true},
		{goos: "linux", name: "xdg-open", args: "/v/a.zip"},
		{goos: "linux", name: "xdg-open", args: "/v", reveal: true},
	} {
		cmd := openCommand
		if tt.reveal {
			cmd = revealCommand
		}
		name, args := cmd(tt.goos, "/v/a.zip")
		if name != tt.name || strings.Join(args, " ") != tt.args {
			t.Errorf("%s reveal=%v: %s %v, want %s %s", tt.goos, tt.reveal, name, args, tt.name, tt.args)
		}
	}
}
