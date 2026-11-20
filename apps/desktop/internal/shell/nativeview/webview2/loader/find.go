// Derived from Wails v3.1.0, internal/webview2/webviewloader (ISC, Copyright (c) 2020 John Chadwick,
// Copyright (c) 2022 Wails Project Developers), a port of OpenWebView2Loader. Reduced for Clarae.
// See NOTICE and LICENSE in internal/shell/nativeview/webview2.

//go:build windows

package loader

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	"golang.org/x/sys/windows/registry"
)

const (
	kNumChannels              = 4
	kInstallKeyPath           = "Software\\Microsoft\\EdgeUpdate\\ClientState\\"
	kMinimumCompatibleVersion = "86.0.616.0"
)

var (
	errNoClientDLLFound = errors.New("no webview2 found")

	kChannelUuid = [kNumChannels]string{
		"{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
		"{2CD8A007-E189-409D-A2C8-9AF4EF3C72AA}",
		"{0D50BFEC-CD6A-4F9A-964C-C7416E3ACB10}",
		"{65C35B14-6C1D-4122-AC46-7148CC9D6497}",
	}

	minimumCompatibleVersion, _ = parseVersion(kMinimumCompatibleVersion)
)

// RuntimeInstalled says whether a runtime of WebView2 that the loader can use is installed: nil, or an error that
// wraps ErrNoRuntime. It is the check that CreateCoreWebView2EnvironmentWithOptions makes first, made alone (no
// environment, no library loaded), so a caller can know early that nothing will work.
func RuntimeInstalled() error {
	_, err := findInstalledClientDll()
	return err
}

// ErrNoRuntime is what RuntimeInstalled returns (and CreateCoreWebView2EnvironmentWithOptions, before it loads anything)
// when no runtime of WebView2 is installed, or the one that is installed is older than the loader supports.
var ErrNoRuntime = errNoClientDLLFound

// findInstalledClientDll looks for the runtime of WebView2 that is installed, by channel (the stable one
// first), for the machine and then for the user.
func findInstalledClientDll() (string, error) {
	for channel := range kNumChannels {
		key := kInstallKeyPath + kChannelUuid[channel]
		for _, checkSystem := range []bool{true, false} {
			clientPath, _, err := findInstalledClientDllForChannel(key, checkSystem)
			if errors.Is(err, errNoClientDLLFound) {
				continue
			}
			if err != nil {
				return "", err
			}
			return clientPath, nil
		}
	}
	return "", errNoClientDLLFound
}

func findInstalledClientDllForChannel(subKey string, system bool) (clientPath string, clientVersion *version, err error) {
	key := registry.LOCAL_MACHINE
	if !system {
		key = registry.CURRENT_USER
	}

	regKey, err := registry.OpenKey(key, subKey, registry.READ|registry.WOW64_32KEY)
	if err != nil {
		return "", nil, mapFindErr(err)
	}
	defer func() { _ = regKey.Close() }()

	embeddedEdgeSubFolder, _, err := regKey.GetStringValue("EBWebView")
	if err != nil {
		return "", nil, mapFindErr(err)
	}

	if embeddedEdgeSubFolder == "" {
		return "", nil, errNoClientDLLFound
	}

	versionString := filepath.Base(embeddedEdgeSubFolder)
	version, err := parseVersion(versionString)
	if err != nil {
		return "", nil, errNoClientDLLFound
	}

	if version.compare(minimumCompatibleVersion) < 0 {
		return "", nil, errNoClientDLLFound
	}

	dllPath, err := findClientDllInFolder(embeddedEdgeSubFolder)
	if err != nil {
		return "", nil, mapFindErr(err)
	}

	return dllPath, &version, nil
}

// findClientDllInFolder is the library of the runtime for this architecture, in the folder the registry
// names (an absolute path).
func findClientDllInFolder(folder string) (string, error) {
	if !filepath.IsAbs(folder) {
		return "", fmt.Errorf("the folder of the WebView2 runtime is not absolute: %q", folder)
	}
	arch := ""
	switch runtime.GOARCH {
	case "arm64":
		arch = "arm64"
	case "amd64":
		arch = "x64"
	case "386":
		arch = "x86"
	default:
		return "", fmt.Errorf("unsupported architecture")
	}

	dllPath := filepath.Join(folder, "EBWebView", arch, "EmbeddedBrowserWebView.dll")
	if _, err := os.Stat(dllPath); err != nil {
		return "", mapFindErr(err)
	}
	return dllPath, nil
}

func mapFindErr(err error) error {
	if errors.Is(err, registry.ErrNotExist) {
		return errNoClientDLLFound
	}
	if errors.Is(err, os.ErrNotExist) {
		return errNoClientDLLFound
	}
	return err
}
