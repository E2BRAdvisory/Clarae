package composer

import (
	"errors"
	"path"
	"regexp"
	"strconv"
	"strings"

	"clarae/apps/desktop/internal/parser"
	"clarae/apps/desktop/internal/vault"
	"clarae/shared/pathrules"
)

// ExtractOptions describe the extraction of a selection into a new note.
type ExtractOptions struct {
	// SourcePath is the note the selection comes from.
	SourcePath string `json:"sourcePath"`
	// Selection is the selected text.
	Selection string `json:"selection"`
	// Title is the new note's name (SuggestTitle when empty).
	Title string `json:"title"`
	// Dir is the folder of the new note; empty means the folder of the source note.
	Dir string `json:"dir"`
	// Embed makes the replacement text ![[note]] instead of [[note]].
	Embed bool `json:"embed"`
	// CarryFrontmatter copies the source note's properties to the new note.
	CarryFrontmatter bool `json:"carryFrontmatter"`
}

// ExtractResult is the new note and the text that replaces the selection.
type ExtractResult struct {
	Path string `json:"path"`
	// Link is what the editor puts where the selection was.
	Link string `json:"link"`
}

var (
	unsafeName = regexp.MustCompile(`[\\/:*?"<>|#^\[\]\x00-\x1f]`)
	listMarker = regexp.MustCompile(`^(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[.\]\s+)?|\d+[.)]\s+)+`)
	inlineMark = regexp.MustCompile("(\\*\\*|__|~~|==|`)")
	wikiMark   = regexp.MustCompile(`!?\[\[(?:[^\]|]*\|)?([^\]]*)\]\]`)
	mdLinkMark = regexp.MustCompile(`!?\[([^\]]*)\]\([^)]*\)`)
)

// SanitizeTitle makes s usable as a note name: characters that are invalid in file
// names or that break links are removed, and the result is capped at 80 characters.
func SanitizeTitle(s string) string {
	s = unsafeName.ReplaceAllString(s, " ")
	s = strings.Join(strings.Fields(s), " ")
	r := []rune(s)
	if len(r) > 80 {
		r = r[:80]
	}
	return strings.Trim(strings.TrimSpace(string(r)), ".")
}

// SuggestTitle derives a note title from a selection: the first non-empty line
// without Markdown decoration (heading marks, list markers, emphasis, link syntax),
// cut at 60 characters on a word boundary. "Untitled" when nothing is usable.
func SuggestTitle(selection string) string {
	for _, line := range strings.Split(selection, "\n") {
		line = strings.TrimSpace(line)
		line = listMarker.ReplaceAllString(line, "")
		line = wikiMark.ReplaceAllString(line, "$1")
		line = mdLinkMark.ReplaceAllString(line, "$1")
		line = inlineMark.ReplaceAllString(line, "")
		line = strings.TrimSpace(strings.TrimRight(line, " #"))
		t := SanitizeTitle(line)
		if t == "" {
			continue
		}
		if r := []rune(t); len(r) > 60 {
			cut := string(r[:60])
			if i := strings.LastIndex(cut, " "); i > 20 {
				cut = cut[:i]
			}
			t = strings.TrimSpace(cut)
		}
		return t
	}
	return "Untitled"
}

// Extract creates the new note (never overwriting: a numeric suffix avoids a clash)
// and returns the text to put in place of the selection. The source note is not
// touched: the editor owns its text and replaces the selection itself, so unsaved
// edits are never overwritten from disk. If the editor fails to apply the
// replacement, the new note is simply an extra note and nothing is lost.
func Extract(fsys *vault.FS, o ExtractOptions) (ExtractResult, error) {
	if strings.TrimSpace(o.Selection) == "" {
		return ExtractResult{}, errors.New("invalid: the selection is empty")
	}
	title := SanitizeTitle(o.Title)
	if title == "" {
		title = SuggestTitle(o.Selection)
	}
	dir := strings.Trim(o.Dir, "/")
	if dir == "" && strings.Contains(o.SourcePath, "/") {
		dir = path.Dir(o.SourcePath)
	}
	// Existing notes decide the free name and whether the short link is ambiguous.
	taken := map[string]bool{}
	stems := map[string]int{}
	if err := fsys.Walk(func(e vault.Entry) error {
		taken[strings.ToLower(e.Path)] = true
		if !e.IsDir && strings.EqualFold(path.Ext(e.Path), ".md") {
			stems[strings.ToLower(strings.TrimSuffix(path.Base(e.Path), path.Ext(e.Path)))]++
		}
		return nil
	}); err != nil {
		return ExtractResult{}, err
	}
	name, rel := title, ""
	for n := 1; ; n++ {
		if n > 1 {
			name = title + " " + strconv.Itoa(n)
		}
		rel = name + ".md"
		if dir != "" {
			rel = dir + "/" + rel
		}
		if !taken[strings.ToLower(rel)] {
			break
		}
	}
	norm, err := pathrules.Normalize(rel)
	if err != nil {
		return ExtractResult{}, err
	}
	var content []byte
	if o.CarryFrontmatter && o.SourcePath != "" {
		if src, err := fsys.ReadFile(o.SourcePath); err == nil {
			if body, _, fm := parser.SplitFrontmatter(src.Data); fm != nil {
				content = append(content, src.Data[:len(src.Data)-len(body)]...)
			}
		}
	}
	content = append(content, []byte(strings.TrimRight(o.Selection, "\r\n")+"\n")...)
	if _, err := fsys.WriteFile(norm, content, "", true); err != nil {
		return ExtractResult{}, err
	}
	target := name
	if stems[strings.ToLower(name)] > 0 {
		target = strings.TrimSuffix(norm, ".md") // another note shares the name: use the path
	}
	link := "[[" + target + "]]"
	if o.Embed {
		link = "!" + link
	}
	return ExtractResult{Path: norm, Link: link}, nil
}
