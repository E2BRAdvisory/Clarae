//go:build !js

package shell

import (
	"io"
	"log/slog"
	"reflect"
	"sync"
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"
)

var testApp struct {
	once sync.Once
	app  *application.App
}

// newTestApp creates the application object once for the process (v3 keeps it in a global that
// menu roles read) without running it.
func newTestApp(t *testing.T) *application.App {
	t.Helper()
	testApp.once.Do(func() {
		testApp.app = application.New(application.Options{
			Name:                        "Clarae notanda",
			Description:                 "test",
			Logger:                      slog.New(slog.NewTextHandler(io.Discard, nil)),
			DisableDefaultSignalHandler: true,
		})
	})
	return testApp.app
}

func dumpMenu(m *application.Menu, indent string, out *[]string) {
	for i := 0; ; i++ {
		it := m.ItemAt(i)
		if it == nil {
			return
		}
		switch {
		case it.IsSeparator():
			*out = append(*out, indent+"---")
		case it.IsSubmenu():
			*out = append(*out, indent+it.Label()+" >")
			dumpMenu(it.GetSubmenu(), indent+"    ", out)
		default:
			*out = append(*out, indent+it.Label())
		}
	}
}

// The menu is App, Edit and Window and nothing else: no View (Reload, Zoom), no Help ("Learn More"
// navigates to wails.io), no File.
func TestExplicitMenuHasOnlyAppEditAndWindow(t *testing.T) {
	newTestApp(t)
	var got []string
	dumpMenu(ExplicitMenu("Clarae notanda"), "", &got)
	var top []string
	for _, l := range got {
		if len(l) > 2 && l[len(l)-2:] == " >" && l[0] != ' ' {
			top = append(top, l[:len(l)-2])
		}
	}
	if want := []string{"Clarae notanda", "Edit", "Window"}; !reflect.DeepEqual(top, want) {
		t.Fatalf("top-level menus = %v, want %v\nfull menu: %q", top, want, got)
	}
	for _, l := range got {
		switch l {
		case "    Reload", "    Force Reload", "    Learn More", "    Services", "    Bring All to Front":
			t.Errorf("unexpected item %q", l)
		}
	}
}

// Menu.Set runs on macOS only; on the other systems the application is not even asked (nil is safe
// because it must not be touched).
func TestMenuIsSetOnlyOnMacOS(t *testing.T) {
	for _, goos := range []string{"windows", "linux", "freebsd"} {
		if SetMenu(nil, goos, "x") {
			t.Errorf("%s: a menu was set", goos)
		}
	}
}

// The URL event is listened to on macOS only: elsewhere the URL comes from os.Args and from the
// second instance, and a listener would deliver it twice.
func TestURLEventIsListenedToOnMacOSOnly(t *testing.T) {
	for _, goos := range []string{"windows", "linux", "freebsd"} {
		if ListenForURLs(nil, goos, func(string) { t.Error("called") }) {
			t.Errorf("%s: a listener was registered", goos)
		}
	}
}
