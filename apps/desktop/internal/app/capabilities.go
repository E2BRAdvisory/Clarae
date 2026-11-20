package app

import (
	"fmt"
	"reflect"
	"runtime"
	"slices"
)

// The capabilities of the host, with one source (ADR-0045 §1). The same UI runs on the desktop
// (Wails) and in the browser (the core as WebAssembly, ADR-0029/0030); what only one of them can
// do is gated on a capability, and the core declares them here. The workbench reads them through
// SettingsAPI.Capabilities before its first render; `task gen` (go run ./internal/app/gen/capabilities)
// writes the same table to packages/workbench/src/platform/capabilities.gen.ts (the type, and the
// values the UI starts from until the core answers) and to shared/parity/capabilities.gen.json (for
// `task parity`). Host methods and functions the browser does not support name the capability
// they gate (host.go: HostMethodCapability); TestHostCapabilities keeps the two consistent.

// Capability names a function of the UI that only some hosts offer. The value is the TypeScript name.
type Capability string

// The capabilities. Every one has a consumer in the UI (`can`, `useCan`, `Command.requires` or the
// `requires`/`excludes` of an action of a panel): `task parity` refuses one that gates nothing.
const (
	CapLocalFolders        Capability = "localFolders"
	CapUpdater             Capability = "updater"
	CapDiskEncryptionCheck Capability = "diskEncryptionCheck"
	CapNativeWindow        Capability = "nativeWindow"
	CapOSTrash             Capability = "osTrash"
	CapMultiVault          Capability = "multiVault"
	CapUnlinkVault         Capability = "unlinkVault"
	CapOwnsSession         Capability = "ownsSession"
	CapDetachedCopies      Capability = "detachedCopies"
	CapOpenWithSystemApp   Capability = "openWithSystemApp"
	CapAIAssistant         Capability = "aiAssistant"
	CapEmbeddedBrowser     Capability = "embeddedBrowser"
	CapTerminal            Capability = "terminal"
)

// Capabilities is what SettingsAPI.Capabilities returns: one bool per capability, the json tag
// being its name (`true` = the UI shows the control). The fields follow CapabilitySpecs.
type Capabilities struct {
	LocalFolders        bool `json:"localFolders"`
	Updater             bool `json:"updater"`
	DiskEncryptionCheck bool `json:"diskEncryptionCheck"`
	NativeWindow        bool `json:"nativeWindow"`
	OSTrash             bool `json:"osTrash"`
	MultiVault          bool `json:"multiVault"`
	UnlinkVault         bool `json:"unlinkVault"`
	OwnsSession         bool `json:"ownsSession"`
	DetachedCopies      bool `json:"detachedCopies"`
	OpenWithSystemApp   bool `json:"openWithSystemApp"`
	AIAssistant         bool `json:"aiAssistant"`
	EmbeddedBrowser     bool `json:"embeddedBrowser"`
	Terminal            bool `json:"terminal"`
}

// CapabilitySpec declares a capability: whether each host offers it, and what it gates (the doc
// comment of the generated TypeScript).
//
// Desktop and Web say what a kind of host can offer. Most capabilities do not depend on the system
// the desktop runs on; one that does lists the systems that offer it in DesktopOS (GOOS values), and
// the core narrows the desktop column to the system it runs on (platformCapabilities). The generated
// tables hold the column as declared: they are the same for every system, the core's own answer is not.
type CapabilitySpec struct {
	Name    Capability
	Desktop bool
	Web     bool
	// DesktopOS limits Desktop to these systems; empty = every system.
	DesktopOS []string
	Doc       string
}

// capabilitySpecs is the table both builds share: the browser's column is written here, not in a
// file of the js build, so that `task gen` (a native program) can write it for the UI and the
// parity check. platformCapabilities picks the column of the running build.
var capabilitySpecs = []CapabilitySpec{
	{CapLocalFolders, true, false, nil,
		"Open a folder of the computer as a vault, pick a folder to import. The browser has cloud vaults only " +
			"(Host.OpenDirectory fails there)."},
	{CapUpdater, true, false, nil,
		"Automatic updates of the application. The Web UI is served by the cloud and is always current " +
			"(every UpdaterAPI method fails in the browser)."},
	{CapDiskEncryptionCheck, true, false, nil,
		"Warn when the disk is not encrypted (a private vault's keys may end up on it). The browser cannot " +
			"tell: VaultCryptoAPI.DiskEncryption always answers \"unknown\" there."},
	{CapNativeWindow, true, false, nil,
		"The window itself (full screen through the OS, the system browser for external links). In the browser " +
			"Host.ShowWindow does nothing and links open in a new tab."},
	{CapOSTrash, true, false, nil,
		"Deleted files can go to the system trash; the browser always uses the vault's `.trash/` (systemTrash " +
			"fails there)."},
	{CapMultiVault, true, false, nil,
		"Several vaults over time in one window: recent vaults, switching from the vault menu. The browser opens " +
			"one vault per page, chosen in the console."},
	{CapUnlinkVault, true, false, nil,
		"A local vault can be disconnected from the cloud and kept as a plain folder. In the browser the copy " +
			"belongs to the cloud vault: it is removed from the browser instead."},
	{CapOwnsSession, true, false, nil,
		"The application owns the cloud session (sign-in through the system browser, sign-out, choice of the " +
			"server). In the browser the session is the page's OIDC one, managed by the console: the core takes its " +
			"tokens from the page (SessionHost) and has no sign-in of its own."},
	{CapDetachedCopies, true, false, nil,
		"A copy that leaves the cloud can stay on this device as a folder of its own: the desktop keeps the mount " +
			"of a revoked share as an ordinary vault. The browser has no place where such a folder could be opened " +
			"again (SharingAPI.RemoveMount refuses keepCopy there): it offers to download the copy as a ZIP instead."},
	{CapOpenWithSystemApp, true, false, nil,
		"A file the application cannot show (an archive, an office document) opens with the application of the " +
			"system, and any file can be shown in the file manager (ADR-0047). The browser offers to download it " +
			"instead (Host.OpenPath and Host.RevealPath fail there)."},
	{CapAIAssistant, true, false, nil,
		"The writing assistant of the editor (ADR-0050): the model is reached from the Go core, which only the " +
			"desktop links (AIAPI refuses every call in the browser, whose Content-Security-Policy allows no third " +
			"party). Even on the desktop it is inactive: it also needs the `ai` flag of the profile, a build that " +
			"enables it, a vault that is not private and a configured provider (AIAPI.Status)."},
	{CapEmbeddedBrowser, true, false, []string{"darwin", "windows", "linux"},
		"The page of an application (a `.webapp` file) opens in a browser embedded in the tab, a native web view " +
			"that the shell adds to the window (ADR-0056, ADR-0062). The desktop has a driver for it on macOS (WKWebView), " +
			"Windows (WebView2) and Linux (WebKitGTK); where the runtime is missing or too old, or CLARAE_WEBVIEW=off, " +
			"the page opens in the system browser. The core also needs the flag `web_viewer` of the profile " +
			"(WebViewAPI.Status). The table says what a desktop can offer; SettingsAPI.Capabilities says what this " +
			"device does (it turns the capability off when the driver cannot be had, for the whole session). The " +
			"browser opens the page in a tab of its own (WebViewAPI refuses every call there)."},
	{CapTerminal, true, false, nil,
		"The integrated terminal (ADR-0064): shells on pseudo-terminals that the Go core starts, in the root of the vault, " +
			"docked in the window or in a separate window of the system. Only the desktop can run processes (macOS, Windows " +
			"and Linux); TerminalAPI refuses every call in the browser with terminal-unavailable, and Host.OpenTerminalWindow " +
			"and Host.CloseTerminalWindow fail there. A vault that is read-only for the user does not open one (TerminalAPI.CanOpen)."},
}

// CapabilitySpecs returns the declared capabilities, in order (for the generator and the tests).
func CapabilitySpecs() []CapabilitySpec {
	return append([]CapabilitySpec(nil), capabilitySpecs...)
}

// CapabilitiesFor returns the capabilities of a host as the table declares them: "desktop" or "web".
// The desktop column is what a desktop can offer on some system; capabilitiesAt narrows it to one.
func CapabilitiesFor(platform string) (Capabilities, error) {
	switch platform {
	case "desktop":
		return capabilitiesAt(false, "")
	case "web":
		return capabilitiesAt(true, "")
	}
	return Capabilities{}, fmt.Errorf("capabilities: unknown platform %q", platform)
}

// capabilitiesAt returns the capabilities of the desktop (web false) running on goos, or of the
// browser. An empty goos is no narrowing: the column as declared.
func capabilitiesAt(web bool, goos string) (Capabilities, error) {
	var c Capabilities
	v := reflect.ValueOf(&c).Elem()
	fields := capabilityFields()
	for _, s := range capabilitySpecs {
		i, ok := fields[s.Name]
		if !ok {
			return Capabilities{}, fmt.Errorf("capabilities: %s has no field in Capabilities", s.Name)
		}
		on := s.Desktop
		if web {
			on = s.Web
		} else if goos != "" && len(s.DesktopOS) > 0 {
			on = on && slices.Contains(s.DesktopOS, goos)
		}
		v.Field(i).SetBool(on)
	}
	if len(fields) != len(capabilitySpecs) {
		return Capabilities{}, fmt.Errorf("capabilities: Capabilities has %d fields for %d specs", len(fields), len(capabilitySpecs))
	}
	return c, nil
}

// capabilityFields maps each capability to its field of Capabilities, by json tag.
func capabilityFields() map[Capability]int {
	t := reflect.TypeFor[Capabilities]()
	out := make(map[Capability]int, t.NumField())
	for i := range t.NumField() {
		out[Capability(t.Field(i).Tag.Get("json"))] = i
	}
	return out
}

// platformCapabilities returns the capabilities of the running build (isWeb: host_native.go,
// host_web.go) on the system it runs on.
func platformCapabilities() Capabilities {
	c, err := capabilitiesAt(isWeb, runtime.GOOS)
	if err != nil {
		panic(err) // a table out of step with the struct: TestCapabilityTable fails first
	}
	return c
}

// Has reports whether the capability is offered (false for a name that is not a capability).
func (c Capabilities) Has(name Capability) bool {
	i, ok := capabilityFields()[name]
	return ok && reflect.ValueOf(c).Field(i).Bool()
}

// Capabilities tells the UI what this host offers (ADR-0045 §1): the workbench reads it before its
// first render, instead of keeping its own table per kind of host.
//
// embeddedBrowser also needs a driver, which the system of the table may still lack (a build without
// cgo, a window that does not exist): the core says false then.
func (s *SettingsAPI) Capabilities() Capabilities {
	c := platformCapabilities()
	if c.EmbeddedBrowser && s.app != nil && !s.app.webviewAvailable() {
		c.EmbeddedBrowser = false
	}
	return c
}
