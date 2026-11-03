package app

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// maxExportHTML bounds a standalone HTML export (images are inlined as data URIs).
const maxExportHTML = 256 << 20

// ExportAPI exposes the single-note exports (standalone HTML, print to PDF). The frontend renders
// the note; Go only asks where to save and writes the file, because the frontend has no disk access.
type ExportAPI struct{ app *App }

// NewExportAPI binds the API.
func NewExportAPI(a *App) *ExportAPI { return &ExportAPI{app: a} }

// SaveHTML asks where to save and writes a standalone HTML document. suggestedName is the note
// name without extension. The document must be self-contained: scripts and remote resources are
// refused here as a second line of defence behind the frontend sanitiser. Cancelling the dialog is
// not an error. The destination must be outside the vault: exporting never modifies it, which also
// keeps read-only (shared viewer) vaults untouched.
func (e *ExportAPI) SaveHTML(vaultID, suggestedName, html string) (ExportResult, error) {
	ov, err := e.app.vault(vaultID)
	if err != nil {
		return ExportResult{}, err
	}
	if err := checkStandaloneHTML(html); err != nil {
		return ExportResult{}, err
	}
	dest, err := e.app.host.SaveFile(e.app.ctx, SaveDialog{
		Title:           "Export note as HTML",
		DefaultFilename: htmlExportFilename(suggestedName, time.Now()),
		Filters:         []FileFilter{{DisplayName: "HTML document (*.html)", Pattern: "*.html"}},
	})
	if err != nil {
		return ExportResult{}, err
	}
	if dest == "" {
		return ExportResult{Cancelled: true}, nil
	}
	res, err := writeExportHTML(ov.FS.Root(), dest, html)
	if err == nil {
		e.app.host.Delivered(e.app.ctx, res.Path)
	}
	return res, err
}

// Print opens the system print dialog for the web view (the user picks "Save as PDF" there).
// The frontend has already switched the page to its print layout.
func (e *ExportAPI) Print() {
	e.app.host.Print(e.app.ctx)
}

var (
	forbiddenTag = regexp.MustCompile(`(?i)<\s*(script|iframe|object|embed|link|base|meta\s+http-equiv\s*=\s*["']?refresh)\b`)
	anyTag       = regexp.MustCompile(`<[a-zA-Z][^>]*>`)
	eventAttr    = regexp.MustCompile(`(?i)\son[a-z]+\s*=`)
	remoteAttr   = regexp.MustCompile(`(?i)\b(src|poster|data|action|formaction|xlink:href)\s*=\s*["']?\s*([a-z][a-z0-9+.-]*:|//)`)
	hrefAttr     = regexp.MustCompile(`(?i)\bhref\s*=\s*["']?\s*(javascript:|file:|data:|vbscript:)`)
	styleBlock   = regexp.MustCompile(`(?is)<style\b[^>]*>(.*?)</style>`)
	remoteInCSS  = regexp.MustCompile(`(?i)url\(\s*["']?\s*(https?:|//|ftp:|file:)|@import`)
)

// checkStandaloneHTML refuses documents that would run code or load remote content. Only markup
// is inspected (text is escaped, so a note quoting "<script>" is fine). Plain external links
// (<a href="https://…">) are allowed: following one is a user action, not a load.
func checkStandaloneHTML(html string) error {
	if len(html) > maxExportHTML {
		return errors.New("export too large")
	}
	if forbiddenTag.MatchString(html) {
		return errors.New("export is not self-contained: it contains scripts or embedded documents")
	}
	for _, m := range styleBlock.FindAllStringSubmatch(html, -1) {
		if remoteInCSS.MatchString(m[1]) {
			return errors.New("export is not self-contained: its stylesheet loads remote resources")
		}
	}
	for _, tag := range anyTag.FindAllString(html, -1) {
		if eventAttr.MatchString(tag) || hrefAttr.MatchString(tag) {
			return errors.New("export is not self-contained: it contains scripts")
		}
		if m := remoteAttr.FindStringSubmatch(tag); m != nil && !strings.EqualFold(m[2], "data:") {
			return errors.New("export is not self-contained: it references a remote resource")
		}
	}
	return nil
}

// htmlExportFilename proposes a file name, keeping only characters safe on every platform.
func htmlExportFilename(noteName string, now time.Time) string {
	return safeExportName(noteName, ".html", "note", now)
}

// safeExportName is "<safe name>-<yyyymmdd><ext>"; an empty name falls back to `fallback`.
func safeExportName(noteName, ext, fallback string, now time.Time) string {
	var b strings.Builder
	for _, r := range noteName {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == '.', r > 127:
			b.WriteRune(r)
		case r == ' ':
			b.WriteByte('_')
		}
	}
	name := strings.Trim(b.String(), "._")
	if name == "" {
		name = fallback
	}
	return fmt.Sprintf("%s-%s%s", name, now.Format("20060102"), ext)
}

// writeExportHTML writes next to dest and renames into place (a failed export never leaves a
// truncated file under the chosen name), refusing destinations inside the vault root.
func writeExportHTML(vaultRoot, dest, html string) (ExportResult, error) {
	if !strings.EqualFold(filepath.Ext(dest), ".html") && !strings.EqualFold(filepath.Ext(dest), ".htm") {
		dest += ".html"
	}
	return writeExportData(vaultRoot, dest, []byte(html))
}

// writeExportData is the destination check and the atomic write shared by every export.
func writeExportData(vaultRoot, dest string, data []byte) (ExportResult, error) {
	return writeExportFrom(vaultRoot, dest, bytes.NewReader(data))
}

// writeExportFrom is writeExportData for a stream (a copy of a vault file of any size).
func writeExportFrom(vaultRoot, dest string, src io.Reader) (ExportResult, error) {
	if r, err := filepath.EvalSymlinks(vaultRoot); err == nil {
		vaultRoot = r
	}
	if dir, err := filepath.EvalSymlinks(filepath.Dir(dest)); err == nil {
		if rel, err := filepath.Rel(vaultRoot, filepath.Join(dir, filepath.Base(dest))); err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return ExportResult{}, errors.New("choose a location outside the vault")
		}
	}
	tmp, err := os.CreateTemp(filepath.Dir(dest), ".memobrain-export-*.part")
	if err != nil {
		return ExportResult{}, err
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	n, err := io.Copy(tmp, src)
	if err == nil {
		err = tmp.Sync()
	}
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return ExportResult{}, err
	}
	if err := os.Chmod(tmp.Name(), 0o644); err != nil {
		return ExportResult{}, err
	}
	if err := os.Rename(tmp.Name(), dest); err != nil {
		return ExportResult{}, err
	}
	return ExportResult{Path: dest, Files: 1, Bytes: n}, nil
}

// exportFormats are the files SaveFile accepts: the MIME type decides the extension and what the
// content must look like. Exports are written outside the vault, so this is the only place where
// the frontend hands bytes to the disk through the system "save as" dialog.
var exportFormats = map[string]struct {
	ext, label string
	check      func(data []byte) error
}{
	"image/png": {".png", "PNG image (*.png)", func(d []byte) error {
		if !bytes.HasPrefix(d, []byte("\x89PNG\r\n\x1a\n")) {
			return errors.New("not a PNG image")
		}
		return nil
	}},
	"image/svg+xml": {".svg", "SVG image (*.svg)", func(d []byte) error {
		if !bytes.Contains(d[:min(len(d), 512)], []byte("<svg")) {
			return errors.New("not an SVG image")
		}
		// An exported drawing must not carry scripts or remote references.
		return checkStandaloneHTML(string(d))
	}},
	"application/pdf": {".pdf", "PDF document (*.pdf)", func(d []byte) error {
		if !bytes.HasPrefix(d, []byte("%PDF-")) {
			return errors.New("not a PDF document")
		}
		return nil
	}},
	"application/json": {".excalidraw", "Excalidraw drawing (*.excalidraw)", func(d []byte) error {
		if !json.Valid(d) {
			return errors.New("not valid JSON")
		}
		return nil
	}},
}

// SaveFile asks where to save and writes base64-encoded `data` of the given MIME type (png, svg,
// pdf or an excalidraw JSON). Cancelling the dialog is not an error. Like SaveHTML it refuses
// destinations inside the vault.
func (e *ExportAPI) SaveFile(vaultID, suggestedName, mime, dataBase64 string) (ExportResult, error) {
	ov, err := e.app.vault(vaultID)
	if err != nil {
		return ExportResult{}, err
	}
	f, ok := exportFormats[mime]
	if !ok {
		return ExportResult{}, fmt.Errorf("invalid-export: unsupported type %q", mime)
	}
	data, err := decodeExport(f.check, dataBase64)
	if err != nil {
		return ExportResult{}, fmt.Errorf("invalid-export: %w", err)
	}
	dest, err := e.app.host.SaveFile(e.app.ctx, SaveDialog{
		Title:           "Save export",
		DefaultFilename: safeExportName(suggestedName, f.ext, "export", time.Now()),
		Filters:         []FileFilter{{DisplayName: f.label, Pattern: "*" + f.ext}},
	})
	if err != nil {
		return ExportResult{}, err
	}
	if dest == "" {
		return ExportResult{Cancelled: true}, nil
	}
	if !strings.EqualFold(filepath.Ext(dest), f.ext) {
		dest += f.ext
	}
	res, err := writeExportData(ov.FS.Root(), dest, data)
	if err == nil {
		e.app.host.Delivered(e.app.ctx, res.Path)
	}
	return res, err
}

// decodeExport decodes and validates the payload of SaveFile.
func decodeExport(check func([]byte) error, b64 string) ([]byte, error) {
	if base64.StdEncoding.DecodedLen(len(b64)) > MaxBinaryBytes {
		return nil, errors.New("export too large")
	}
	data, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return nil, err
	}
	if len(data) == 0 {
		return nil, errors.New("empty export")
	}
	if err := check(data); err != nil {
		return nil, err
	}
	return data, nil
}
