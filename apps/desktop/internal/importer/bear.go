package importer

import (
	"encoding/json"
	"errors"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

func init() {
	Register(&source{id: "bear", detect: detectBear, exec: execBear}, SourceInfo{Input: "either", Extensions: []string{"bearbk", "textbundle", "textpack", "zip"}})
}

func isBundleDir(seg string) bool {
	l := strings.ToLower(seg)
	return strings.HasSuffix(l, ".textbundle") || strings.HasSuffix(l, ".textpack")
}

func detectBear(p string) (bool, error) {
	switch strings.ToLower(filepath.Ext(p)) {
	case ".bearbk", ".textbundle", ".textpack":
		return true, nil
	}
	st, err := os.Stat(p)
	if err != nil {
		return false, err
	}
	if !st.IsDir() {
		return false, nil
	}
	ents, err := os.ReadDir(p)
	if err != nil {
		return false, err
	}
	for _, e := range ents {
		if isBundleDir(e.Name()) {
			return true, nil
		}
	}
	return false, nil
}

// bundleOf returns the text bundle a file belongs to ("" with ok when the archive itself is
// the bundle) and the path inside it.
func bundleOf(file string, rootIsBundle bool) (root, inner string, ok bool) {
	segs := strings.Split(file, "/")
	for i, s := range segs[:len(segs)-1] {
		if isBundleDir(s) {
			return strings.Join(segs[:i+1], "/"), strings.Join(segs[i+1:], "/"), true
		}
	}
	if rootIsBundle {
		return "", file, true
	}
	return "", "", false
}

var (
	bearMulti = regexp.MustCompile(`(^|\s)#([^#\s\n](?:[^#\n]*[^#\s\n])?)#(\s|$|[.,;:!?)])`)
	bearTag   = regexp.MustCompile(`(^|\s)#([\p{L}\p{N}_][\p{L}\p{N}_/\-]*)`)
	bearOld   = regexp.MustCompile(`\[(image|file):[^\]]*\]`)
	headingRe = regexp.MustCompile(`^#{1,6}\s`)
)

type bearNote struct {
	src      string
	name     string
	info     map[string]any
	assetSrc []string
}

// extractBearTags returns the Markdown with "#multi word#" tags made valid and the tags found
// outside code.
func extractBearTags(md string) (string, []string) {
	var tags []string
	var out []string
	inFence := false
	for _, l := range strings.Split(md, "\n") {
		t := strings.TrimLeft(l, " ")
		if strings.HasPrefix(t, "```") || strings.HasPrefix(t, "~~~") {
			inFence = !inFence
			out = append(out, l)
			continue
		}
		if inFence || headingRe.MatchString(l) {
			out = append(out, l)
			continue
		}
		l = mapInline(l, func(seg string) string {
			seg = bearMulti.ReplaceAllStringFunc(seg, func(m string) string {
				sm := bearMulti.FindStringSubmatch(m)
				name := tagName(sm[2])
				if name == "" {
					return m
				}
				tags = append(tags, name)
				return sm[1] + "#" + name + sm[3]
			})
			for _, sm := range bearTag.FindAllStringSubmatch(seg, -1) {
				tags = append(tags, sm[2])
			}
			return seg
		})
		out = append(out, l)
	}
	return strings.Join(out, "\n"), tagList(tags)
}

func bearTime(info map[string]any, key string) (time.Time, bool) {
	b, _ := info["net.shinyfrog.bear"].(map[string]any)
	if b == nil {
		return time.Time{}, false
	}
	s, _ := b[key].(string)
	t, err := time.Parse(time.RFC3339, s)
	return t, err == nil
}

func execBear(r *run, p string) error {
	tree, err := OpenTree(p, r.lim)
	if err != nil {
		return err
	}
	defer func() { _ = tree.Close() }()
	for _, rj := range tree.Rejected() {
		r.warn("Ignored %s", rj)
	}
	rootIsBundle := hasRootText(tree)
	rootName := stemOf(p)

	notes := map[string]*bearNote{} // bundle root -> note
	var order []string
	var plain []string // Markdown files outside bundles
	var loose []string // other files outside bundles
	for _, f := range tree.Files() {
		root, inner, ok := bundleOf(f.Path, rootIsBundle)
		if !ok {
			if hiddenPath(f.Path) {
				continue
			}
			switch strings.ToLower(path.Ext(f.Path)) {
			case ".md", ".markdown":
				plain = append(plain, f.Path)
			default:
				loose = append(loose, f.Path)
			}
			continue
		}
		n := notes[root]
		if n == nil {
			name := rootName
			if root != "" {
				name = strings.TrimSuffix(path.Base(root), path.Ext(root))
			}
			n = &bearNote{name: name}
			notes[root] = n
			order = append(order, root)
		}
		switch l := strings.ToLower(inner); {
		case l == "text.md" || l == "text.markdown" || l == "text.txt":
			n.src = f.Path
		case l == "info.json":
			if data, err := readAll(tree, f.Path); err == nil {
				_ = json.Unmarshal(data, &n.info)
			}
		case strings.HasPrefix(l, "assets/"):
			n.assetSrc = append(n.assetSrc, f.Path)
		}
	}
	total := len(plain) + len(loose)
	for _, k := range order {
		total += 1 + len(notes[k].assetSrc)
	}
	if total == 0 {
		return errors.New("invalid: no Bear notes found")
	}
	r.setTotal(total)

	// attachments first, so links can be mapped to their new places
	assets := map[string]target{}
	rw := newRewriter(r.opts.UseWikilinks, func(src string) (target, bool) {
		t, ok := assets[src]
		return t, ok
	})
	copyAsset := func(src string) error {
		if err := r.step(src); err != nil {
			return err
		}
		if r.sink.Dry() {
			d, err := r.reserveAbs(joinPath(r.attachmentsDir(), sanitizeFile(path.Base(src))))
			if err == nil {
				r.created("attachment", src, d, "")
				assets[src] = target{Dest: d, Attachment: true}
				rw.register(d, true)
			}
			return nil
		}
		data, err := readAll(tree, src)
		if err != nil {
			r.fail("attachment", src, "", err)
			return nil
		}
		d, err := r.putAttachment(src, path.Base(src), data)
		if err == nil {
			assets[src] = target{Dest: d, Attachment: true}
			rw.register(d, true)
		}
		return nil
	}
	for _, k := range order {
		for _, a := range notes[k].assetSrc {
			if err := copyAsset(a); err != nil {
				return err
			}
		}
	}
	for _, a := range loose {
		if err := copyAsset(a); err != nil {
			return err
		}
	}

	oldRefs := 0
	write := func(src, name string, text string, info map[string]any) error {
		if err := r.step(src); err != nil {
			return err
		}
		text = normalizeText(text)
		title := name
		for _, l := range strings.Split(text, "\n") {
			if t := strings.TrimSpace(l); t != "" {
				if strings.HasPrefix(t, "# ") {
					title = strings.TrimSpace(strings.TrimPrefix(t, "# "))
				}
				break
			}
		}
		if title == "" {
			title = name
		}
		dest, err := r.reserve(sanitizeName(title) + ".md")
		if err != nil {
			r.fail("note", src, "", err)
			return nil
		}
		text, tags := extractBearTags(text)
		oldRefs += len(bearOld.FindAllString(text, -1))
		text = rw.rewrite(text, src, dest)
		var props []Prop
		if t, ok := bearTime(info, "creationDate"); ok {
			props = append(props, Prop{Key: "created", Value: isoTime(t)})
		}
		if t, ok := bearTime(info, "modificationDate"); ok {
			props = append(props, Prop{Key: "updated", Value: isoTime(t)})
		}
		if len(tags) > 0 {
			props = append(props, Prop{Key: "tags", Value: tags})
		}
		_ = r.writeNote(src, title, dest, buildNote(props, text))
		return nil
	}
	for _, k := range order {
		n := notes[k]
		if n.src == "" {
			r.skip("note", k, "text bundle without text.md")
			continue
		}
		data, err := readAll(tree, n.src)
		if err != nil {
			r.fail("note", n.src, "", err)
			continue
		}
		if err := write(n.src, n.name, string(data), n.info); err != nil {
			return err
		}
	}
	for _, f := range plain {
		data, err := readAll(tree, f)
		if err != nil {
			r.fail("note", f, "", err)
			continue
		}
		if err := write(f, stemOf(f), string(data), nil); err != nil {
			return err
		}
	}
	if oldRefs > 0 {
		r.warn("%d Bear attachment reference(s) of the form [image:...] / [file:...] could not be resolved; use a .textbundle export", oldRefs)
	}
	finishRewrites(r, rw)
	return nil
}

func hasRootText(t Tree) bool {
	for _, f := range t.Files() {
		switch strings.ToLower(f.Path) {
		case "text.md", "text.markdown", "text.txt":
			return true
		}
	}
	return false
}
