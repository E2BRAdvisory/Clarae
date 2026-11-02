package importer

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

func init() {
	Register(&source{id: "google-keep", detect: detectKeep, exec: execKeep}, SourceInfo{Input: "either", Extensions: []string{"zip"}})
}

type keepNote struct {
	Title                   string `json:"title"`
	TextContent             string `json:"textContent"`
	IsTrashed               bool   `json:"isTrashed"`
	IsPinned                bool   `json:"isPinned"`
	IsArchived              bool   `json:"isArchived"`
	Color                   string `json:"color"`
	CreatedTimestampUsec    int64  `json:"createdTimestampUsec"`
	UserEditedTimestampUsec int64  `json:"userEditedTimestampUsec"`
	Labels                  []struct {
		Name string `json:"name"`
	} `json:"labels"`
	ListContent []struct {
		Text      string `json:"text"`
		IsChecked bool   `json:"isChecked"`
	} `json:"listContent"`
	Attachments []struct {
		FilePath string `json:"filePath"`
		Mimetype string `json:"mimetype"`
	} `json:"attachments"`
	Annotations []struct {
		URL         string `json:"url"`
		Title       string `json:"title"`
		Description string `json:"description"`
	} `json:"annotations"`
}

func looksLikeKeep(data []byte) bool {
	return bytes.Contains(data, []byte(`"userEditedTimestampUsec"`)) || bytes.Contains(data, []byte(`"isTrashed"`))
}

func detectKeep(p string) (bool, error) {
	st, err := os.Stat(p)
	if err != nil {
		return false, err
	}
	if !st.IsDir() && !strings.EqualFold(filepath.Ext(p), ".zip") {
		return false, nil
	}
	t, err := OpenTree(p, DefaultLimits)
	if err != nil {
		return false, nil
	}
	defer func() { _ = t.Close() }()
	checked := 0
	for _, f := range t.Files() {
		ext := strings.ToLower(path.Ext(f.Path))
		if ext != ".json" && ext != ".html" {
			continue
		}
		if path.Base(path.Dir(f.Path)) == "Keep" {
			return true, nil
		}
		if checked++; checked > 5 {
			break
		}
		rc, err := t.Open(f.Path)
		if err != nil {
			continue
		}
		head := make([]byte, 16<<10)
		n, _ := rc.Read(head)
		_ = rc.Close()
		if looksLikeKeep(head[:n]) || looksLikeKeepHTML(head[:n]) {
			return true, nil
		}
	}
	return false, nil
}

func execKeep(r *run, p string) error {
	tree, err := OpenTree(p, r.lim)
	if err != nil {
		return err
	}
	defer func() { _ = tree.Close() }()
	for _, rj := range tree.Rejected() {
		r.warn("Ignored %s", rj)
	}
	byDir := map[string][]string{}
	var jsons, htmls []string
	stems := map[string]bool{}
	for _, f := range tree.Files() {
		byDir[path.Dir(f.Path)] = append(byDir[path.Dir(f.Path)], f.Path)
		switch strings.ToLower(path.Ext(f.Path)) {
		case ".json":
			jsons = append(jsons, f.Path)
			stems[strings.TrimSuffix(f.Path, path.Ext(f.Path))] = true
		case ".html":
			htmls = append(htmls, f.Path)
		}
	}
	// A note exported in both formats is read from its JSON, which carries more (creation date).
	htmls = slices.DeleteFunc(htmls, func(h string) bool { return stems[strings.TrimSuffix(h, path.Ext(h))] })
	r.setTotal(len(jsons) + len(htmls))
	notes := 0
	for _, jp := range jsons {
		if err := r.step(jp); err != nil {
			return err
		}
		data, err := readAll(tree, jp)
		if err != nil {
			r.fail("note", jp, "", err)
			continue
		}
		if !looksLikeKeep(data) {
			continue // not a note (labels, settings, ...)
		}
		var kn keepNote
		if err := json.Unmarshal(data, &kn); err != nil {
			r.fail("note", jp, "", fmt.Errorf("invalid JSON: %w", err))
			continue
		}
		if kn.IsTrashed && !r.opts.IncludeTrashed {
			r.skip("note", jp, "trashed note")
			continue
		}
		if kn.IsArchived && !r.opts.IncludeArchived {
			r.skip("note", jp, "archived note")
			continue
		}
		notes++
		importKeepNote(r, tree, byDir, jp, &kn)
	}
	for _, hp := range htmls {
		if err := r.step(hp); err != nil {
			return err
		}
		data, err := readAll(tree, hp)
		if err != nil {
			r.fail("note", hp, "", err)
			continue
		}
		kn, ok := parseKeepHTML(data)
		if !ok {
			continue // not a note (the index page of an export, …)
		}
		if kn.IsTrashed && !r.opts.IncludeTrashed {
			r.skip("note", hp, "trashed note")
			continue
		}
		if kn.IsArchived && !r.opts.IncludeArchived {
			r.skip("note", hp, "archived note")
			continue
		}
		notes++
		importKeepNote(r, tree, byDir, hp, &kn)
	}
	if notes == 0 && len(r.rep.Skipped) == 0 && len(r.rep.Failed) == 0 {
		return fmt.Errorf("invalid: no Google Keep notes found")
	}
	return nil
}

func usecTime(us int64) (time.Time, bool) {
	if us <= 0 {
		return time.Time{}, false
	}
	return time.UnixMicro(us), true
}

func importKeepNote(r *run, tree Tree, byDir map[string][]string, jp string, kn *keepNote) {
	title := strings.TrimSpace(kn.Title)
	created, hasCreated := usecTime(kn.CreatedTimestampUsec)
	if title == "" {
		first := strings.TrimSpace(strings.SplitN(strings.TrimSpace(kn.TextContent), "\n", 2)[0])
		if first == "" && len(kn.ListContent) > 0 {
			first = strings.TrimSpace(kn.ListContent[0].Text)
		}
		if len([]rune(first)) > 60 {
			first = string([]rune(first)[:60])
		}
		title = first
	}
	if title == "" {
		if hasCreated {
			title = "Keep note " + created.Format("2006-01-02 1504")
		} else {
			title = "Keep note " + strings.TrimSuffix(path.Base(jp), path.Ext(jp))
		}
	}
	noteDest, err := r.reserve(sanitizeName(title) + ".md")
	if err != nil {
		r.fail("note", jp, "", err)
		return
	}

	var b strings.Builder
	if t := strings.TrimSpace(kn.TextContent); t != "" {
		b.WriteString(normalizeText(t) + "\n\n")
	}
	for _, it := range kn.ListContent {
		mark := "[ ] "
		if it.IsChecked {
			mark = "[x] "
		}
		b.WriteString("- " + mark + strings.ReplaceAll(strings.TrimSpace(it.Text), "\n", " ") + "\n")
	}
	for _, at := range kn.Attachments {
		if at.FilePath == "" {
			continue
		}
		src := findKeepFile(byDir[path.Dir(jp)], path.Join(path.Dir(jp), at.FilePath))
		if src == "" {
			r.warn("%s: attachment %s is not in the export", jp, at.FilePath)
			continue
		}
		dest, err := r.putAttachmentFrom(tree, src, path.Base(src))
		if err != nil {
			continue
		}
		var ref string
		isMedia := isImageExt(dest) || strings.HasPrefix(at.Mimetype, "image/") || strings.HasPrefix(at.Mimetype, "audio/")
		bang := map[bool]string{true: "!", false: ""}[isMedia]
		if r.opts.UseWikilinks {
			ref = bang + "[[" + path.Base(dest) + "]]"
		} else {
			ref = bang + "[" + path.Base(dest) + "](" + escapePath(relPath(path.Dir(noteDest), dest)) + ")"
		}
		b.WriteString("\n" + ref + "\n")
	}
	var links []string
	for _, a := range kn.Annotations {
		if u := strings.TrimSpace(a.URL); u != "" && safeHref(u) != "" {
			t := strings.TrimSpace(a.Title)
			if t == "" {
				t = u
			}
			links = append(links, "- ["+strings.NewReplacer("[", "", "]", "", "\n", " ").Replace(t)+"]("+linkDest(u)+")")
		}
	}
	if len(links) > 0 {
		b.WriteString("\n## Links\n\n" + strings.Join(links, "\n") + "\n")
	}

	var props []Prop
	if hasCreated {
		props = append(props, Prop{Key: "created", Value: isoTime(created)})
	}
	if t, ok := usecTime(kn.UserEditedTimestampUsec); ok {
		props = append(props, Prop{Key: "updated", Value: isoTime(t)})
	}
	var labels []string
	for _, l := range kn.Labels {
		labels = append(labels, l.Name)
	}
	if tags := tagList(labels); len(tags) > 0 {
		props = append(props, Prop{Key: "tags", Value: tags})
	}
	if kn.IsPinned {
		props = append(props, Prop{Key: "pinned", Value: true})
	}
	if kn.IsArchived {
		props = append(props, Prop{Key: "archived", Value: true})
	}
	if kn.IsTrashed {
		props = append(props, Prop{Key: "trashed", Value: true})
	}
	if c := strings.ToUpper(strings.TrimSpace(kn.Color)); c != "" && c != "DEFAULT" {
		props = append(props, Prop{Key: "color", Value: strings.ToLower(c)})
	}
	_ = r.writeNote(jp, title, noteDest, buildNote(props, b.String()))
}

// findKeepFile finds an attachment next to its note; Takeout sometimes renames the extension
// (.jpeg/.jpg), so a file with the same stem is accepted when the exact name is absent.
func findKeepFile(candidates []string, want string) string {
	for _, c := range candidates {
		if c == want {
			return c
		}
	}
	stem := strings.TrimSuffix(want, path.Ext(want))
	for _, c := range candidates {
		if strings.TrimSuffix(c, path.Ext(c)) == stem && !strings.EqualFold(path.Ext(c), ".json") {
			return c
		}
	}
	return ""
}
