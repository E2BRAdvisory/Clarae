package app

import (
	"os"
	"path"
	"runtime"

	"clarae/shared/pathrules"
)

// Files the application does not show itself (ADR-0047): on the desktop they open with the
// application of the system, in the browser they are downloaded. The routing by type is the
// frontend's (openFile in the workbench); these bindings only act on one file of the vault.

// OpenWithSystemApp opens a file of the vault with the application the operating system associates
// with its type. Folders and executables are refused (code "executable" for the latter): a file
// that arrived with the sync of a shared vault must never run as a program on a click.
// Capability: openWithSystemApp (Host.OpenPath fails in the browser).
func (v *VaultAPI) OpenWithSystemApp(vaultID, relPath string) error {
	abs, normalized, err := v.vaultFile(vaultID, relPath)
	if err != nil {
		return err
	}
	if executable, err := isExecutableFile(abs, normalized); err != nil {
		return bindingError(err)
	} else if executable {
		return coded(ErrCodeExecutable, normalized+" is a program: show it in the file manager to open it", nil)
	}
	return bindingError(v.app.host.OpenPath(v.app.ctx, abs))
}

// RevealInFolder shows a file of the vault selected in the system file manager (executables
// included: nothing is opened).
// Capability: openWithSystemApp (Host.RevealPath fails in the browser).
func (v *VaultAPI) RevealInFolder(vaultID, relPath string) error {
	abs, _, err := v.vaultFile(vaultID, relPath)
	if err != nil {
		return err
	}
	return bindingError(v.app.host.RevealPath(v.app.ctx, abs))
}

// DownloadFile saves a copy of a file of the vault outside it: in the browser the copy becomes a
// download (Host.Delivered), on the desktop the user picks where in the "save as" dialog. The file
// is streamed, so there is no size limit. Read-only vaults can be copied from. Cancelling the
// dialog is not an error.
func (v *VaultAPI) DownloadFile(vaultID, relPath string) (ExportResult, error) {
	ov, err := v.app.vault(vaultID)
	if err != nil {
		return ExportResult{}, err
	}
	abs, normalized, err := v.vaultFile(vaultID, relPath)
	if err != nil {
		return ExportResult{}, err
	}
	dest, err := v.app.host.SaveFile(v.app.ctx, SaveDialog{
		Title:           "Save a copy",
		DefaultFilename: path.Base(normalized),
	})
	if err != nil {
		return ExportResult{}, err
	}
	if dest == "" {
		return ExportResult{Cancelled: true}, nil
	}
	f, err := os.Open(abs)
	if err != nil {
		return ExportResult{}, bindingError(err)
	}
	defer func() { _ = f.Close() }()
	res, err := writeExportFrom(ov.FS.Root(), dest, f)
	if err != nil {
		return ExportResult{}, bindingError(err)
	}
	v.app.host.Delivered(v.app.ctx, res.Path)
	return res, nil
}

// vaultFile resolves a vault-relative path to a regular file (FS.Resolve refuses paths that leave
// the vault, symlinks included).
func (v *VaultAPI) vaultFile(vaultID, relPath string) (abs, normalized string, err error) {
	ov, err := v.app.vault(vaultID)
	if err != nil {
		return "", "", err
	}
	abs, normalized, err = ov.FS.Resolve(relPath)
	if err != nil {
		return "", "", bindingError(err)
	}
	st, err := os.Stat(abs)
	if err != nil {
		return "", "", bindingError(err)
	}
	if !st.Mode().IsRegular() {
		// A folder (a macOS .app bundle is one) is never handed to the system.
		return "", "", coded(ErrCodeInvalidPath, normalized+" is not a file", nil)
	}
	return abs, normalized, nil
}

// isExecutableFile tells whether the system would run the file when opening it: by its extension,
// or, outside Windows, an extensionless file with an execute bit (macOS opens those in the
// Terminal). A file with another extension opens by its type whatever its mode.
func isExecutableFile(abs, normalized string) (bool, error) {
	if pathrules.IsExecutable(normalized) {
		return true, nil
	}
	if runtime.GOOS == "windows" || pathrules.Ext(normalized) != "" {
		return false, nil
	}
	st, err := os.Stat(abs)
	if err != nil {
		return false, err
	}
	return st.Mode().Perm()&0o111 != 0, nil
}
