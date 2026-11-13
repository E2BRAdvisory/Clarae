package templates

import (
	"path"
	"sort"
	"strings"

	"clarae/apps/desktop/internal/vault"
	"clarae/shared/pathrules"
)

// DefaultFolder is the template folder when none is configured.
const DefaultFolder = "Templates"

// Sources of a template.
const (
	SourceVault   = "vault"   // a note of the open vault
	SourceLibrary = "library" // a note of the read-only group library mount
)

// LibraryPrefix marks a template reference that points into the group library.
const LibraryPrefix = "library:"

// Template is a note usable as template.
type Template struct {
	// Name is the file name without extension.
	Name string `json:"name"`
	// Path is relative to the vault (or to the library root for SourceLibrary).
	Path string `json:"path"`
	// Source is SourceVault or SourceLibrary.
	Source string `json:"source"`
	// Ref is the string that identifies the template in settings: the path for the
	// vault, "library:<path>" for the library.
	Ref string `json:"ref"`
}

// ParseRef splits a template reference into its source and path.
func ParseRef(ref string) (source, p string) {
	if rest, ok := strings.CutPrefix(ref, LibraryPrefix); ok {
		return SourceLibrary, rest
	}
	return SourceVault, ref
}

// RefFor builds the reference of a template.
func RefFor(source, p string) string {
	if source == SourceLibrary {
		return LibraryPrefix + p
	}
	return p
}

// List returns the Markdown notes under folder of fsys (recursively), sorted by path.
// An empty folder means DefaultFolder; with allNotes the whole vault is searched
// instead (used for a library, whose root is the template folder). A missing
// folder yields no templates.
func List(fsys *vault.FS, folder, source string, allNotes bool) ([]Template, error) {
	prefix := ""
	if !allNotes {
		folder = strings.Trim(folder, "/")
		if folder == "" {
			folder = DefaultFolder
		}
		norm, err := pathrules.Normalize(folder)
		if err != nil {
			return []Template{}, nil //nolint:nilerr // an invalid folder name holds no templates
		}
		prefix = norm
	}
	out := []Template{}
	err := fsys.Walk(func(e vault.Entry) error {
		if e.IsDir || !strings.EqualFold(path.Ext(e.Path), ".md") {
			return nil
		}
		if pathrules.HasPrefix(e.Path, pathrules.TrashDir) || pathrules.IsConfigPath(e.Path) {
			return nil
		}
		if prefix != "" && !pathrules.HasPrefix(e.Path, prefix) {
			return nil
		}
		out = append(out, Template{
			Name:   strings.TrimSuffix(path.Base(e.Path), path.Ext(e.Path)),
			Path:   e.Path,
			Source: source,
			Ref:    RefFor(source, e.Path),
		})
		return nil
	})
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].Path) < strings.ToLower(out[j].Path) })
	return out, err
}
