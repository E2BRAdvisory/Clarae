package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path"
	"regexp"
	"strings"

	"clarae/apps/desktop/internal/drawing"
	"clarae/apps/desktop/internal/vault"
	"clarae/shared/pathrules"
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

// drawingCacheDir is where the previews of drawings are cached (never synchronized).
const drawingCacheDir = pathrules.ConfigDir + "/cache/drawings"

// previewVariantSuffix maps a preview variant to the suffix of its cache file: "" is the light
// preview ("<hash>.svg"), "dark" the one rendered for the dark theme ("<hash>.dark.svg").
var previewVariantSuffix = map[string]string{"": "", "dark": ".dark"}

func previewPath(hash, variant string) (string, error) {
	if !hashRe.MatchString(hash) {
		return "", fmt.Errorf("invalid: %q is not a content hash", hash)
	}
	suffix, ok := previewVariantSuffix[variant]
	if !ok {
		return "", fmt.Errorf("invalid: unknown preview variant %q", variant)
	}
	return drawingCacheDir + "/" + hash + suffix + ".svg", nil
}

// DrawingPreview is what Preview returns.
type DrawingPreview struct {
	// Hash is the content hash of the drawing as it is on disk (the one ReadNote gives).
	Hash string `json:"hash"`
	// SVG is the preview cached for that hash; empty when there is none.
	SVG string `json:"svg"`
}

// Preview returns the content hash of the drawing at relPath and the SVG cached for it. The file
// is streamed through the hash, never loaded: an embed whose preview is in the cache costs no
// read of the drawing (megabytes, with pictures in it) on either side of the bridge. A drawing
// that changed has another hash, so it simply misses the cache. variant is "" (light) or "dark":
// each has its own cached picture.
func (d *DrawingAPI) Preview(vaultID, relPath, variant string) (DrawingPreview, error) {
	ov, err := d.app.vault(vaultID)
	if err != nil {
		return DrawingPreview{}, err
	}
	if _, ok := previewVariantSuffix[variant]; !ok {
		return DrawingPreview{}, fmt.Errorf("invalid: unknown preview variant %q", variant)
	}
	if !strings.EqualFold(path.Ext(relPath), ".excalidraw") {
		return DrawingPreview{}, fmt.Errorf("invalid: %q is not a drawing", relPath)
	}
	hash, _, err := ov.FS.HashFile(relPath)
	if err != nil {
		return DrawingPreview{}, bindingError(err)
	}
	svg, err := cachedPreview(ov.FS, hash, variant)
	if err != nil {
		return DrawingPreview{}, err
	}
	return DrawingPreview{Hash: hash, SVG: svg}, nil
}

// cachedPreview is the SVG cached for a drawing hash and variant ("" when there is none).
func cachedPreview(fsys *vault.FS, hash, variant string) (string, error) {
	p, err := previewPath(hash, variant)
	if err != nil {
		return "", err
	}
	c, err := fsys.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return string(c.Data), nil
}

// SavePreview caches the SVG rendered for a drawing hash, in the light ("") or "dark" variant. The
// cache is local: it is never synchronized (pathrules) and can be deleted at any time.
func (d *DrawingAPI) SavePreview(vaultID, hash, variant, svg string) error {
	ov, err := d.app.vault(vaultID)
	if err != nil {
		return err
	}
	p, err := previewPath(hash, variant)
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
// third-party Excalidraw plugin ("Board.excalidraw.png", "Board.excalidraw.dark.svg"). Computing the
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
	if norm, nerr := pathrules.Normalize(drawingPath); nerr == nil && pathrules.IsConfigPath(norm) {
		// The template of a drawing, open in a tab: no picture is written next to it, where it would
		// sync with the settings and sit among the templates.
		return "", errors.New("invalid: a drawing of the configuration folder has no export file")
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

// legacySuffix is the file name ending of the drawings of the third-party Excalidraw plugin.
const legacySuffix = ".excalidraw.md"

// maxLegacyImages bounds the images inlined into a converted drawing (Spec §2.7.1 warns above 10 MB
// per drawing, so this is generous but finite).
const maxLegacyImages = 40 << 20

// ImportLegacy converts a third-party ".excalidraw.md" note of the vault into a standard
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
		return "", fmt.Errorf("invalid: %q is not an Excalidraw Markdown note (%s)", srcRel, legacySuffix)
	}
	abs, _, err := ov.FS.Resolve(srcRel)
	if err != nil {
		return "", bindingError(err)
	}
	if st, err := os.Stat(abs); err == nil && st.Size() > drawing.MaxLegacyNoteSize {
		return "", fmt.Errorf("invalid: %q is too large to be imported", srcRel) // not read at all
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
	out, err := drawing.ConvertLegacyMD(src.Data, images)
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
