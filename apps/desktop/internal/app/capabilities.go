package app

import (
	"fmt"
	"reflect"
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
}

// CapabilitySpec declares a capability: whether each host offers it, and what it gates (the doc
// comment of the generated TypeScript).
type CapabilitySpec struct {
	Name    Capability
	Desktop bool
	Web     bool
	Doc     string
}

// capabilitySpecs is the table both builds share: the browser's column is written here, not in a
// file of the js build, so that `task gen` (a native program) can write it for the UI and the
// parity check. platformCapabilities picks the column of the running build.
var capabilitySpecs = []CapabilitySpec{
	{CapLocalFolders, true, false,
		"Open a folder of the computer as a vault, pick a folder to import. The browser has cloud vaults only " +
			"(Host.OpenDirectory fails there)."},
	{CapUpdater, true, false,
		"Automatic updates of the application. The Web UI is served by the cloud and is always current " +
			"(every UpdaterAPI method fails in the browser)."},
	{CapDiskEncryptionCheck, true, false,
		"Warn when the disk is not encrypted (a private vault's keys may end up on it). The browser cannot " +
			"tell: VaultCryptoAPI.DiskEncryption always answers \"unknown\" there."},
	{CapNativeWindow, true, false,
		"The window itself (full screen through the OS, the system browser for external links). In the browser " +
			"Host.ShowWindow does nothing and links open in a new tab."},
	{CapOSTrash, true, false,
		"Deleted files can go to the system trash; the browser always uses the vault's `.trash/` (systemTrash " +
			"fails there)."},
	{CapMultiVault, true, false,
		"Several vaults over time in one window: recent vaults, switching from the vault menu. The browser opens " +
			"one vault per page, chosen in the console."},
	{CapUnlinkVault, true, false,
		"A local vault can be disconnected from the cloud and kept as a plain folder. In the browser the copy " +
			"belongs to the cloud vault: it is removed from the browser instead."},
	{CapOwnsSession, true, false,
		"The application owns the cloud session (sign-in through the system browser, sign-out, choice of the " +
			"server). In the browser the session is the page's OIDC one, managed by the console: the core takes its " +
			"tokens from the page (SessionHost) and has no sign-in of its own."},
	{CapDetachedCopies, true, false,
		"A copy that leaves the cloud can stay on this device as a folder of its own: the desktop keeps the mount " +
			"of a revoked share as an ordinary vault. The browser has no place where such a folder could be opened " +
			"again (SharingAPI.RemoveMount refuses keepCopy there): it offers to download the copy as a ZIP instead."},
}

// CapabilitySpecs returns the declared capabilities, in order (for the generator and the tests).
func CapabilitySpecs() []CapabilitySpec {
	return append([]CapabilitySpec(nil), capabilitySpecs...)
}

// CapabilitiesFor returns the capabilities of a host: "desktop" or "web".
func CapabilitiesFor(platform string) (Capabilities, error) {
	var web bool
	switch platform {
	case "desktop":
	case "web":
		web = true
	default:
		return Capabilities{}, fmt.Errorf("capabilities: unknown platform %q", platform)
	}
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

// platformCapabilities returns the capabilities of the running build (isWeb: host_wails.go, host_web.go).
func platformCapabilities() Capabilities {
	platform := "desktop"
	if isWeb {
		platform = "web"
	}
	c, err := CapabilitiesFor(platform)
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
func (s *SettingsAPI) Capabilities() Capabilities { return platformCapabilities() }
