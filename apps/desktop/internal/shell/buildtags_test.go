//go:build !js

package shell

import (
	"reflect"
	"runtime/debug"
	"testing"
)

func info(tags string) *debug.BuildInfo {
	return &debug.BuildInfo{Settings: []debug.BuildSetting{{Key: "-trimpath", Value: "true"}, {Key: "-tags", Value: tags}}}
}

func TestForbiddenBuildTags(t *testing.T) {
	for _, c := range []struct {
		tags  string
		found []string
		prod  bool
	}{
		{"production", nil, true},
		{"production,gtk3", nil, true},
		{"production,mcp", []string{"mcp"}, true},
		{"gtk3,server,production", []string{"server"}, true},
		{"production,devtools,mcp", []string{"mcp", "devtools"}, true},
		{"devtools", []string{"devtools"}, false},
		{"", nil, false},
	} {
		found, prod := ForbiddenBuildTags(info(c.tags))
		if !reflect.DeepEqual(found, c.found) || prod != c.prod {
			t.Errorf("%q: found %v production %v, want %v %v", c.tags, found, prod, c.found, c.prod)
		}
	}
	if f, p := ForbiddenBuildTags(nil); f != nil || p {
		t.Error("no build info: nothing to report")
	}
}

// The binary the tests run in is built without them: a `go test -tags server` (or mcp, devtools)
// of this package fails here, as a release build with them would (see also main.go, which refuses
// to start a production binary that has one).
func TestThisBuildHasNoForbiddenTags(t *testing.T) {
	bi, ok := debug.ReadBuildInfo()
	if !ok {
		t.Skip("no build info")
	}
	if found, _ := ForbiddenBuildTags(bi); len(found) > 0 {
		t.Fatalf("built with the tags %v", found)
	}
}
