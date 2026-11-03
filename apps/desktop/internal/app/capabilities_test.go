package app

import (
	"reflect"
	"testing"
)

// The table of the capabilities and the Capabilities struct describe the same names (ADR-0045 §1).
func TestCapabilityTable(t *testing.T) {
	seen := map[Capability]bool{}
	for _, s := range CapabilitySpecs() {
		if s.Name == "" || s.Doc == "" {
			t.Errorf("capability %q: a name and a doc are required", s.Name)
		}
		if seen[s.Name] {
			t.Errorf("capability %s: declared twice", s.Name)
		}
		seen[s.Name] = true
		if !s.Desktop && !s.Web {
			t.Errorf("capability %s: no host offers it, so it gates nothing", s.Name)
		}
	}
	fields := capabilityFields()
	for name := range fields {
		if !seen[name] {
			t.Errorf("field %q of Capabilities has no entry in capabilitySpecs", name)
		}
	}
	for name := range seen {
		if _, ok := fields[name]; !ok {
			t.Errorf("capability %s has no field in Capabilities", name)
		}
	}
	for _, p := range []string{"desktop", "web"} {
		c, err := CapabilitiesFor(p)
		if err != nil {
			t.Fatal(err)
		}
		for _, s := range CapabilitySpecs() {
			want := s.Desktop
			if p == "web" {
				want = s.Web
			}
			if c.Has(s.Name) != want {
				t.Errorf("%s: %s = %v, want %v", p, s.Name, c.Has(s.Name), want)
			}
		}
	}
	if _, err := CapabilitiesFor("mobile"); err == nil {
		t.Error("an unknown platform must be refused")
	}
	if (Capabilities{LocalFolders: true}).Has("noSuchCapability") {
		t.Error("an unknown capability is never offered")
	}
}

// Every method of Host is classified, and a method gated by a capability has it on the desktop and
// not in the browser: the UI never shows a control whose call fails on the host it runs on.
// host_web_test.go (task test-wasm) checks that the browser's Host fails only in gated methods.
func TestHostCapabilities(t *testing.T) {
	desktop, _ := CapabilitiesFor("desktop")
	web, _ := CapabilitiesFor("web")
	known := map[Capability]bool{}
	for _, s := range CapabilitySpecs() {
		known[s.Name] = true
	}
	host := reflect.TypeFor[Host]()
	methods := map[string]bool{}
	for i := range host.NumMethod() {
		name := host.Method(i).Name
		methods[name] = true
		gate, ok := HostMethodCapability[name]
		if !ok {
			t.Errorf("Host.%s is not classified in HostMethodCapability: name the capability it needs, or \"\"", name)
			continue
		}
		if gate == "" {
			continue
		}
		if !known[gate] {
			t.Errorf("Host.%s: %s is not a capability", name, gate)
		}
		if !desktop.Has(gate) || web.Has(gate) {
			t.Errorf("Host.%s is gated by %s: it must be true on the desktop and false in the browser (desktop %v, web %v)",
				name, gate, desktop.Has(gate), web.Has(gate))
		}
	}
	for name := range HostMethodCapability {
		if !methods[name] {
			t.Errorf("HostMethodCapability names %s, which is not a method of Host", name)
		}
	}
}

// The binding answers with the column of the running build.
func TestSettingsCapabilitiesFollowTheBuild(t *testing.T) {
	want, _ := CapabilitiesFor("desktop")
	if isWeb {
		want, _ = CapabilitiesFor("web")
	}
	if got := (&SettingsAPI{}).Capabilities(); got != want {
		t.Fatalf("SettingsAPI.Capabilities() = %+v, want %+v", got, want)
	}
	// The functions of the core the browser lacks follow their capability too.
	if isWeb == want.OSTrash {
		t.Errorf("osTrash = %v with isWeb = %v: systemTrash is gated by it", want.OSTrash, isWeb)
	}
	if isWeb == want.Updater {
		t.Errorf("updater = %v with isWeb = %v: UpdaterAPI is gated by it", want.Updater, isWeb)
	}
}
