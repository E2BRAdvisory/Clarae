package platform

import (
	"os"
	"path/filepath"
)

// legacyWebViewDirNames are the profile folders that WebView2 made for the executable of 1.x under
// %AppData%: they are named after the file. The installer put it there as "<product name>.exe"
// (PRODUCT_EXECUTABLE of the NSIS template, from the name in project.json); a build run from the
// output directory has the name of the output file. Dropped in 3.0.
var legacyWebViewDirNames = []string{legacyProductName + ".exe", "memobrain.exe"}

// WebViewDataDir is where the WebView2 profile of the application lives on Windows: inside the data
// directory, not in %AppData%\<name of the executable>, so that the storage of the web view does not
// depend on the name of the file.
func WebViewDataDir(dataDir string) string { return filepath.Join(dataDir, "webview") }

// AdoptLegacyWebViewData moves the WebView2 profile of 1.x (<appData>\<its executable>) to
// WebViewDataDir, unless a profile is already there: what the web view stored (the settings of the
// window, the choices that the interface keeps in the browser storage) is still there after the
// update. A profile that cannot be moved, because the old application has it open, stays where it
// is. It is for Windows; appData is %AppData%.
func AdoptLegacyWebViewData(dataDir, appData string) []Note {
	if appData == "" {
		return nil
	}
	src := ""
	for _, name := range legacyWebViewDirNames {
		p := filepath.Join(appData, name)
		if fi, err := os.Stat(p); err == nil && fi.IsDir() {
			src = p
			break
		}
	}
	if src == "" {
		return nil
	}
	dst := WebViewDataDir(dataDir)
	if _, err := os.Lstat(dst); err == nil {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return []Note{{Warn: true, Msg: "web view data of the previous version not moved: " + err.Error()}}
	}
	if err := rename(src, dst); err != nil {
		return []Note{{Warn: true, Msg: "web view data of the previous version left at " + src + ": " + err.Error()}}
	}
	return []Note{{Msg: "moved the web view data of the previous version from " + src + " to " + dst}}
}

// LegacyInstallNotes reports the previous application where it can be seen: on macOS its bundle in
// /Applications, which stays there after the new one is installed (the two
// are different applications). It does no harm, but two icons for one set of data confuse.
func LegacyInstallNotes(goos string) []Note {
	return legacyInstallNotes(goos, func(p string) bool { _, err := os.Stat(p); return err == nil })
}

func legacyInstallNotes(goos string, exists func(path string) bool) []Note {
	if goos != "darwin" {
		return nil
	}
	bundle := "/Applications/" + legacyProductName + ".app"
	if !exists(bundle) {
		return nil
	}
	return []Note{{Warn: true, Msg: bundle + " is still installed: Clarae notanda replaces it, and it can be moved to the Trash"}}
}
