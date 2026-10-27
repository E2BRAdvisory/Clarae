package app

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
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
	dest, err := runtime.SaveFileDialog(e.app.ctx, runtime.SaveDialogOptions{
		Title:           "Export note as HTML",
		DefaultFilename: htmlExportFilename(suggestedName, time.Now()),
		Filters:         []runtime.FileFilter{{DisplayName: "HTML document (*.html)", Pattern: "*.html"}},
	})
	if err != nil {
		return ExportResult{}, err
	}
	if dest == "" {
		return ExportResult{Cancelled: true}, nil
	}
	return writeExportHTML(ov.FS.Root(), dest, html)
}

// Print opens the system print dialog for the web view (the user picks "Save as PDF" there).
// The frontend has already switched the page to its print layout.
func (e *ExportAPI) Print() {
	runtime.WindowPrint(e.app.ctx)
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
		name = "note"
	}
	return fmt.Sprintf("%s-%s.html", name, now.Format("20060102"))
}

// writeExportHTML writes next to dest and renames into place (a failed export never leaves a
// truncated file under the chosen name), refusing destinations inside the vault root.
func writeExportHTML(vaultRoot, dest, html string) (ExportResult, error) {
	if !strings.EqualFold(filepath.Ext(dest), ".html") && !strings.EqualFold(filepath.Ext(dest), ".htm") {
		dest += ".html"
	}
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
	n, err := tmp.WriteString(html)
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
	return ExportResult{Path: dest, Files: 1, Bytes: int64(n)}, nil
}
