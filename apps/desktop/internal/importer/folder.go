package importer

import (
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"memobrain/apps/desktop/internal/parser"
)

func init() {
	Register(&source{id: "markdown-folder", detect: detectMarkdownFolder, exec: func(r *run, p string) error {
		return importFolder(r, p, folderSpec{})
	}}, SourceInfo{Input: "either", Extensions: []string{"zip"}})
}

// folderSpec customises the shared folder/archive engine (Notion strips ids and reads CSVs).
type folderSpec struct {
	mapSegment func(string) string
	notion     bool
	// stripRoot drops the single top-level folder that wraps a whole export.
	stripRoot bool
}

func (s folderSpec) mapName(seg string) string {
	if s.mapSegment != nil {
		return s.mapSegment(seg)
	}
	return seg
}

// entry is one source file with its planned destination.
type entry struct {
	src  string
	kind string // note | html | attachment | csv
	dest string
}

func classify(name string, spec folderSpec) string {
	switch strings.ToLower(path.Ext(name)) {
	case ".md", ".markdown":
		return "note"
	case ".html", ".htm":
		return "html"
	case ".csv":
		if spec.notion {
			return "csv"
		}
	}
	return "attachment"
}

func hiddenPath(p string) bool {
	for _, seg := range strings.Split(p, "/") {
		if strings.HasPrefix(seg, ".") {
			return true
		}
	}
	return false
}

func detectMarkdownFolder(p string) (bool, error) {
	has := func(name string) bool {
		switch strings.ToLower(path.Ext(name)) {
		case ".md", ".markdown", ".html", ".htm":
			return true
		}
		return false
	}
	st, err := os.Stat(p)
	if err != nil {
		return false, err
	}
	if st.IsDir() {
		found, seen := false, 0
		_ = filepath.WalkDir(p, func(q string, d fs.DirEntry, err error) error {
			if err != nil || found {
				return nil
			}
			if d.IsDir() && strings.HasPrefix(d.Name(), ".") && q != p {
				return filepath.SkipDir
			}
			if seen++; seen > 5000 {
				return filepath.SkipAll
			}
			if !d.IsDir() && has(d.Name()) {
				found = true
				return filepath.SkipAll
			}
			return nil
		})
		return found, nil
	}
	if strings.ToLower(filepath.Ext(p)) != ".zip" {
		return false, nil
	}
	t, err := OpenTree(p, DefaultLimits)
	if err != nil {
		return false, nil
	}
	defer func() { _ = t.Close() }()
	for _, f := range t.Files() {
		if has(f.Path) {
			return true, nil
		}
	}
	return false, nil
}

func importFolder(r *run, p string, spec folderSpec) error {
	tree, err := OpenTree(p, r.lim)
	if err != nil {
		return err
	}
	defer func() { _ = tree.Close() }()
	for _, rj := range tree.Rejected() {
		r.warn("Ignored %s", rj)
		r.skip("attachment", rj, "rejected for safety")
	}

	// 1. classify
	var entries []*entry
	hidden := 0
	for _, f := range tree.Files() {
		if hiddenPath(f.Path) {
			hidden++
			continue
		}
		entries = append(entries, &entry{src: f.Path, kind: classify(f.Path, spec)})
	}
	if hidden > 0 {
		r.warn("%d hidden files and folders were ignored", hidden)
	}
	if spec.notion {
		entries = dropDuplicateCSV(entries)
	}
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].src < entries[j].src })
	r.setTotal(len(entries))

	// 2. plan destinations (reserved before any content is converted, so links can be fixed)
	bySrc := map[string]target{}
	byLower := map[string]target{}
	rw := newRewriter(r.opts.UseWikilinks, func(src string) (target, bool) {
		if t, ok := bySrc[src]; ok {
			return t, true
		}
		if t, ok := byLower[strings.ToLower(src)]; ok {
			return t, true
		}
		if t, ok := byLower[strings.ToLower(src)+".md"]; ok {
			return t, true
		}
		return target{}, false
	})
	wrapper := ""
	if spec.stripRoot && len(entries) > 0 {
		wrapper = strings.SplitN(entries[0].src, "/", 2)[0]
		for _, e := range entries {
			if !strings.HasPrefix(e.src, wrapper+"/") {
				wrapper = ""
				break
			}
		}
	}
	segs := func(dir string) []string {
		if wrapper != "" {
			dir = strings.TrimPrefix(strings.TrimPrefix(dir, wrapper), "/")
		}
		if dir == "." || dir == "" {
			return nil
		}
		parts := strings.Split(dir, "/")
		for i, s := range parts {
			parts[i] = sanitizeName(spec.mapName(s))
		}
		return parts
	}
	for _, e := range entries {
		if e.kind == "csv" {
			continue
		}
		dir := strings.Join(segs(path.Dir(e.src)), "/")
		var dest string
		var err error
		switch e.kind {
		case "note", "html":
			dest, err = r.reserve(joinPath(dir, sanitizeName(spec.mapName(stemOf(e.src)))+".md"))
		default:
			name := sanitizeFile(path.Base(e.src))
			if r.opts.AttachmentsFolder != "" {
				dest, err = r.reserveAbs(joinPath(r.opts.AttachmentsFolder, name))
			} else {
				dest, err = r.reserve(joinPath(dir, name))
			}
		}
		if err != nil {
			r.fail(map[bool]string{true: "attachment", false: "note"}[e.kind == "attachment"], e.src, "", err)
			continue
		}
		e.dest = dest
		t := target{Dest: dest, Attachment: e.kind == "attachment"}
		bySrc[e.src] = t
		byLower[strings.ToLower(e.src)] = t
		rw.register(dest, t.Attachment)
	}

	// Notion databases: properties for the row pages, new notes for rows without a page, index notes.
	var extra map[string][]Prop
	var post []func() error
	if spec.notion {
		extra, post = notionDatabases(r, tree, entries, spec, segs, bySrc, rw)
	}

	// 3. notes
	drops := map[string]int{}
	for _, e := range entries {
		if e.dest == "" || e.kind == "attachment" || e.kind == "csv" {
			continue
		}
		if err := r.step(e.src); err != nil {
			return err
		}
		data, err := readAll(tree, e.src)
		if err != nil {
			r.fail("note", e.src, e.dest, err)
			continue
		}
		text := normalizeText(string(data))
		title := stemOf(e.dest)
		if e.kind == "html" {
			res, err := htmlToMarkdown(text, htmlHooks{})
			if err != nil {
				r.fail("note", e.src, e.dest, err)
				continue
			}
			for _, d := range res.Dropped {
				drops[d]++
			}
			text = res.Markdown
		}
		text = rw.rewrite(text, e.src, e.dest)
		if props := extra[e.src]; len(props) > 0 {
			text = withProps(text, props, r, e.src)
		}
		if !strings.HasSuffix(text, "\n") {
			text += "\n"
		}
		_ = r.writeNote(e.src, title, e.dest, []byte(text))
	}
	reportDrops(r, drops)

	// 4. attachments
	for _, e := range entries {
		if e.dest == "" || e.kind != "attachment" {
			continue
		}
		if err := r.step(e.src); err != nil {
			return err
		}
		if r.sink.Dry() {
			r.created("attachment", e.src, e.dest, "")
			continue
		}
		data, err := readAll(tree, e.src)
		if err != nil {
			r.fail("attachment", e.src, e.dest, err)
			continue
		}
		_ = r.writeAttachment(e.src, e.dest, data)
	}
	for _, f := range post {
		if err := f(); err != nil {
			return err
		}
	}
	finishRewrites(r, rw)
	return nil
}

// withProps prepends frontmatter built from props to text (which has none).
func withProps(text string, props []Prop, r *run, src string) string {
	if _, _, fm := parser.SplitFrontmatter([]byte(text)); fm != nil {
		r.warn("%s: kept its own frontmatter, database properties were not added", src)
		return text
	}
	return string(buildNote(props, text))
}

func reportDrops(r *run, drops map[string]int) {
	keys := make([]string, 0, len(drops))
	for k := range drops {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		r.warn("Removed %d '%s' item(s) from HTML content for safety", drops[k], k)
	}
}

func finishRewrites(r *run, rw *rewriter) {
	r.rep.LinksRewritten += rw.rewritten
	r.rep.LinksUnresolved += rw.unresCount
	if rw.unresCount > 0 {
		r.warn("%d link(s) point to files that are not part of the import, e.g. %s", rw.unresCount, strings.Join(rw.unresolved, ", "))
	}
}

// normalizeText strips a BOM and converts CRLF/CR to LF.
func normalizeText(s string) string {
	s = strings.TrimPrefix(s, "\ufeff")
	if strings.Contains(s, "\r") {
		s = strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", "\n"), "\r", "\n")
	}
	return strings.ReplaceAll(s, "\x00", "")
}
