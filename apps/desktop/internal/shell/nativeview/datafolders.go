//go:build !js

package nativeview

// Where the session data of the applications live, for the drivers that keep them in a folder of their own
// (Windows: the user data folder of WebView2; Linux: the data and cache folders of WebKitGTK). It builds everywhere
// (except WebAssembly) so that a machine that is not the one of the driver can test it.

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
)

var errNoDataFolder = errors.New("no data folder for the applications")

// webappsRoot is where the session data of the applications live: a folder next to the one of the web
// view of the application (platform.WebViewDataDir, <data dir>/webview), so <data dir>/webapps. It is
// derived from the path the application gave to Wails, because the driver is not told the data
// directory; "" when Wails was given none (its default is %AppData%\<executable>, which is not ours).
func webappsRoot(webviewUserDataPath string) string {
	if webviewUserDataPath == "" || !filepath.IsAbs(webviewUserDataPath) {
		return ""
	}
	return webappsDir(filepath.Dir(filepath.Clean(webviewUserDataPath)))
}

// webappsDir is <data dir>/webapps for the data directory of the application, "" when it is not an absolute path.
func webappsDir(dataDir string) string {
	if dataDir == "" || !filepath.IsAbs(dataDir) {
		return ""
	}
	return filepath.Join(filepath.Clean(dataDir), "webapps")
}

// userDataFolder is the user data folder of WebView2 for a data store: <root>\<store>. One folder per
// store, hence per vault, and a store is never a path: it must be a UUID-like identifier, so nothing
// of it can reach outside root. The name is lower case, because the file system of Windows is not
// sensitive to it and two spellings must not make two folders (or one folder shared by two stores).
func userDataFolder(root, store string) (string, error) {
	if root == "" {
		return "", errNoDataFolder
	}
	if store == "" || len(store) > 64 {
		return "", fmt.Errorf("data store %q is not an identifier", store)
	}
	for _, c := range store {
		alnum := c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
		if !alnum && c != '-' {
			return "", fmt.Errorf("data store %q is not an identifier", store)
		}
	}
	if strings.HasPrefix(store, "-") {
		return "", fmt.Errorf("data store %q is not an identifier", store)
	}
	return filepath.Join(root, strings.ToLower(store)), nil
}
