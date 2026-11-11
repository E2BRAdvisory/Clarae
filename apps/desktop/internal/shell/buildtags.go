//go:build !js

package shell

import (
	"runtime/debug"
	"strings"
)

// forbiddenTags are the build tags of Wails v3 that must never reach a released binary: "mcp" starts
// a server on 127.0.0.1:9099 that drives the application, "server" turns the application into an
// HTTP server without a window, "devtools" opens the web inspector (and v3's `wails3 dev` adds tags
// from the environment).
var forbiddenTags = []string{"mcp", "server", "devtools"}

// ForbiddenBuildTags returns the forbidden tags that info says the binary was built with, and
// whether it is a production build (the tag "production" is ours to pass to go build, B-D9). A dev
// build may carry devtools; a production one may not carry any.
func ForbiddenBuildTags(info *debug.BuildInfo) (found []string, production bool) {
	if info == nil {
		return nil, false
	}
	var tags []string
	for _, s := range info.Settings {
		if s.Key == "-tags" {
			tags = append(tags, strings.Split(s.Value, ",")...)
		}
	}
	has := map[string]bool{}
	for _, t := range tags {
		has[strings.TrimSpace(t)] = true
	}
	for _, f := range forbiddenTags {
		if has[f] {
			found = append(found, f)
		}
	}
	return found, has["production"]
}
