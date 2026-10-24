package vault

import (
	"archive/zip"
	"context"
	"io"
	"os"
	"path"
	"strings"

	"nodus/shared/pathrules"
)

// ExportStats counts what an export wrote.
type ExportStats struct {
	Files int   `json:"files"`
	Dirs  int   `json:"dirs"`
	Bytes int64 `json:"bytes"`
}

// textual lists the formats worth deflating; everything else (images, audio, archives) is
// stored as is.
var textual = map[string]bool{
	".md": true, ".canvas": true, ".base": true, ".excalidraw": true, ".json": true, ".txt": true,
	".csv": true, ".svg": true, ".html": true, ".css": true, ".js": true, ".xml": true, ".yaml": true, ".yml": true,
}

// ExportZip writes the vault as a ZIP archive: ordinary files with their relative paths and
// modification times, empty folders included, so unpacking it yields a vault Obsidian opens.
// Device-specific and derived data (workspace layout, caches, local databases) and the
// in-vault trash are left out. The context cancels a long export between files.
func (f *FS) ExportZip(ctx context.Context, w io.Writer) (ExportStats, error) {
	var st ExportStats
	zw := zip.NewWriter(w)
	err := f.Walk(func(e Entry) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if e.Path == pathrules.TrashDir || strings.HasPrefix(e.Path, pathrules.TrashDir+"/") {
			return nil
		}
		if e.IsDir {
			if _, err := zw.CreateHeader(&zip.FileHeader{Name: e.Path + "/", Method: zip.Store, Modified: e.Mtime}); err != nil {
				return err
			}
			st.Dirs++
			return nil
		}
		abs, _, err := f.Resolve(e.Path)
		if err != nil {
			return nil // vanished or became unsafe since the walk: skip it
		}
		src, err := os.Open(abs)
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		defer func() { _ = src.Close() }()
		method := zip.Store
		if textual[strings.ToLower(path.Ext(e.Path))] {
			method = zip.Deflate
		}
		fw, err := zw.CreateHeader(&zip.FileHeader{Name: e.Path, Method: method, Modified: e.Mtime})
		if err != nil {
			return err
		}
		n, err := io.Copy(fw, src)
		if err != nil {
			return err
		}
		st.Files++
		st.Bytes += n
		return nil
	})
	if err != nil {
		return st, err
	}
	return st, zw.Close()
}
