package app

import (
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"

	"nodus/shared/pathrules"
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
