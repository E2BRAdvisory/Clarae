package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path"
	"regexp"
	"strings"

	"memobrain/apps/desktop/internal/drawing"
	"memobrain/apps/desktop/internal/vault"
	"memobrain/shared/pathrules"
)

// DrawingAPI stores the SVG previews of drawings (§M3-WP2). The frontend renders
// them with Excalidraw's exportToSvg and caches them by the hash of the drawing's
// content, so a changed drawing simply misses the cache.
type DrawingAPI struct{ app *App }

// NewDrawingAPI binds the API.
func NewDrawingAPI(a *App) *DrawingAPI { return &DrawingAPI{app: a} }

// MaxPreviewBytes bounds one cached preview.
const MaxPreviewBytes = 4 << 20

var hashRe = regexp.MustCompile(`^[0-9a-f]{64}$`)

func previewPath(hash string) (string, error) {
	if !hashRe.MatchString(hash) {
		return "", fmt.Errorf("invalid: %q is not a content hash", hash)
	}
	return pathrules.ConfigDir + "/cache/drawings/" + hash + ".svg", nil
}

// ReadPreview returns the cached SVG for a drawing hash ("" when there is none).
func (d *DrawingAPI) ReadPreview(vaultID, hash string) (string, error) {
	ov, err := d.app.vault(vaultID)
	if err != nil {
		return "", err
	}
	p, err := previewPath(hash)
	if err != nil {
		return "", err
	}
	c, err := ov.FS.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return string(c.Data), nil
}

// SavePreview caches the SVG rendered for a drawing hash. The cache is local: it is
// never synchronized (pathrules) and can be deleted at any time.
func (d *DrawingAPI) SavePreview(vaultID, hash, svg string) error {
	ov, err := d.app.vault(vaultID)
	if err != nil {
		return err
	}
	p, err := previewPath(hash)
	if err != nil {
		return err
	}
	if len(svg) > MaxPreviewBytes {
		return errors.New("invalid: preview is too large")
	}
	if !strings.HasPrefix(strings.TrimSpace(svg), "<svg") || strings.Contains(strings.ToLower(svg), "<script") {
		return errors.New("invalid: not an SVG image")
	}
	_, err = ov.FS.WriteFile(p, []byte(svg), "", false)
	return bindingError(err)
}

// exportVariants are the optional theme markers of an auto-exported file ("Board.excalidraw.dark.png").
var exportVariants = map[string]bool{"": true, "light": true, "dark": true}

// exportTarget is where the auto-export of a drawing goes: next to it, named after it, like the
// Obsidian Excalidraw plugin ("Board.excalidraw.png", "Board.excalidraw.dark.svg"). Computing the
// path here keeps the frontend from writing anywhere else.
func exportTarget(drawingPath, variant, format string) (string, error) {
	if !strings.EqualFold(path.Ext(drawingPath), ".excalidraw") {
		return "", fmt.Errorf("invalid: %q is not a drawing", drawingPath)
	}
	if !exportVariants[variant] {
		return "", fmt.Errorf("invalid: unknown variant %q", variant)
	}
	if format != "png" && format != "svg" {
		return "", fmt.Errorf("invalid: unknown format %q", format)
	}
	if variant != "" {
		variant += "."
	}
	return drawingPath + "." + variant + format, nil
}

// WriteExport (over)writes the PNG/SVG export of a drawing next to it and returns its path. Unlike
// SaveAttachment it replaces the previous export: auto-export runs on every save.
func (d *DrawingAPI) WriteExport(vaultID, drawingPath, variant, format, dataBase64 string) (string, error) {
	if err := d.app.writable(vaultID); err != nil {
		return "", err
	}
	ov, err := d.app.vault(vaultID)
	if err != nil {
		return "", err
	}
	target, err := exportTarget(drawingPath, variant, format)
	if err != nil {
		return "", err
	}
	if _, err := ov.FS.ReadFile(drawingPath); err != nil {
		return "", bindingError(err) // the drawing must exist
	}
	mime := "image/png"
	if format == "svg" {
		mime = "image/svg+xml"
	}
	data, err := decodeExport(exportFormats[mime].check, dataBase64)
	if err != nil {
		return "", fmt.Errorf("invalid: %w", err)
	}
	c, err := ov.FS.WriteFile(target, data, "", false)
	if err != nil {
		return "", bindingError(err)
	}
	_ = ov.Indexer.Update(context.Background(), []string{c.Path})
	return c.Path, nil
}

// legacySuffix is the file name ending of the Obsidian Excalidraw plugin's drawings.
const legacySuffix = ".excalidraw.md"

// maxLegacyImages bounds the images inlined into a converted drawing (Spec §2.7.1 warns above 10 MB
// per drawing, so this is generous but finite).
const maxLegacyImages = 40 << 20

// ImportLegacy converts an Obsidian ".excalidraw.md" note of the vault into a standard
// ".excalidraw" drawing next to it (plain JSON, Spec §2.7.1) and returns the new path. The note is
// left untouched; images it embeds are read from the vault and stored in the drawing's files.
func (d *DrawingAPI) ImportLegacy(vaultID, srcRel string) (string, error) {
	if err := d.app.writable(vaultID); err != nil {
		return "", err
	}
	ov, err := d.app.vault(vaultID)
	if err != nil {
		return "", err
	}
	if !strings.HasSuffix(strings.ToLower(srcRel), legacySuffix) {
		return "", fmt.Errorf("invalid: %q is not an Obsidian Excalidraw note (%s)", srcRel, legacySuffix)
	}
	src, err := ov.FS.ReadFile(srcRel)
	if err != nil {
		return "", bindingError(err)
	}
	var tree []vault.Entry
	total := 0
	images := func(link string) ([]byte, string, bool) {
		mime := drawing.ImageMIME(link)
		if mime == "" {
			return nil, "", false
		}
		candidates := []string{strings.TrimPrefix(link, "/")}
		if tree == nil {
			tree, _ = ov.FS.ListTree()
		}
		for _, e := range tree {
			if !e.IsDir && strings.EqualFold(path.Base(e.Path), path.Base(link)) {
				candidates = append(candidates, e.Path)
			}
		}
		for _, p := range candidates {
			c, err := ov.FS.ReadFile(p)
			if err != nil || total+len(c.Data) > maxLegacyImages {
				continue
			}
			total += len(c.Data)
			return c.Data, mime, true
		}
		return nil, "", false
	}
	out, err := drawing.ConvertObsidianMD(src.Data, images)
	if err != nil {
		return "", err
	}
	stem := srcRel[:len(srcRel)-len(legacySuffix)]
	for i := 0; i < 1000; i++ {
		candidate := stem + ".excalidraw"
		if i > 0 {
			candidate = fmt.Sprintf("%s %d.excalidraw", stem, i)
		}
		c, err := ov.FS.WriteFile(candidate, out, "", true)
		if errors.Is(err, vault.ErrExists) {
			continue
		}
		if err != nil {
			return "", bindingError(err)
		}
		_ = ov.Indexer.Update(context.Background(), []string{c.Path})
		return c.Path, nil
	}
	return "", errors.New("exists: too many drawings with that name")
}
