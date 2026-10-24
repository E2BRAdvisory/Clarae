package importer

import (
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
)

func init() {
	Register(&source{id: "notion", detect: detectNotion, exec: func(r *run, p string) error {
		return importFolder(r, p, folderSpec{mapSegment: stripNotionID, notion: true, stripRoot: true})
	}}, SourceInfo{Input: "either", Extensions: []string{"zip"}})
}

// Notion appends " <32 hex digits>" to every page and folder name ("_all" marks the CSV with
// every column of a database).
var notionIDRe = regexp.MustCompile(`\s+[0-9a-f]{32}(_all)?$`)

func stripNotionID(seg string) string {
	if out := notionIDRe.ReplaceAllString(seg, ""); strings.TrimSpace(out) != "" {
		return out
	}
	return seg
}

func detectNotion(p string) (bool, error) {
	match := func(name string) bool {
		switch strings.ToLower(path.Ext(name)) {
		case ".md", ".csv", ".html":
			return notionIDRe.MatchString(stemOf(name))
		}
		return false
	}
	st, err := os.Stat(p)
	if err != nil {
		return false, err
	}
	if !st.IsDir() {
		if strings.ToLower(filepath.Ext(p)) != ".zip" {
			return false, nil
		}
		t, err := OpenTree(p, DefaultLimits)
		if err != nil {
			return false, nil
		}
		defer func() { _ = t.Close() }()
		for _, f := range t.Files() {
			if match(f.Path) {
				return true, nil
			}
		}
		return false, nil
	}
	found, seen := false, 0
	_ = filepath.WalkDir(p, func(q string, d os.DirEntry, err error) error {
		if err != nil || found {
			return nil
		}
		if seen++; seen > 5000 {
			return filepath.SkipAll
		}
		if !d.IsDir() && match(d.Name()) {
			found = true
			return filepath.SkipAll
		}
		return nil
	})
	return found, nil
}

// dropDuplicateCSV removes "X_all.csv" when "X.csv" exists (same database, fewer columns).
func dropDuplicateCSV(entries []*entry) []*entry {
	have := map[string]bool{}
	for _, e := range entries {
		if e.kind == "csv" {
			have[strings.ToLower(e.src)] = true
		}
	}
	out := entries[:0]
	for _, e := range entries {
		if e.kind == "csv" && strings.HasSuffix(strings.ToLower(stemOf(e.src)), "_all") {
			plain := strings.TrimSuffix(e.src, path.Ext(e.src))
			plain = plain[:len(plain)-len("_all")] + path.Ext(e.src)
			if have[strings.ToLower(plain)] {
				continue
			}
		}
		out = append(out, e)
	}
	return out
}

// notionDatabases handles the CSV files of a Notion export: the properties of each row go
// into the frontmatter of the row's page (or of a new note when the export has no page for it)
// and an index note lists the database. It returns the properties to add per source page and
// the closures that write the generated notes after the pages.
func notionDatabases(r *run, tree Tree, entries []*entry, spec folderSpec, segs func(string) []string, bySrc map[string]target, rw *rewriter) (map[string][]Prop, []func() error) {
	extra := map[string][]Prop{}
	var post []func() error

	notesByDir := map[string]map[string]*entry{}
	for _, e := range entries {
		if e.dest == "" || (e.kind != "note" && e.kind != "html") {
			continue
		}
		dir := path.Dir(e.src)
		if notesByDir[dir] == nil {
			notesByDir[dir] = map[string]*entry{}
		}
		notesByDir[dir][strings.ToLower(sanitizeName(spec.mapName(stemOf(e.src))))] = e
	}
	for _, e := range entries {
		if e.kind == "attachment" && strings.EqualFold(path.Ext(e.src), ".zip") && path.Dir(e.src) == "." {
			r.warn("%s is a nested archive: extract it and import the inner export too", e.src)
		}
	}

	for _, e := range entries {
		if e.kind != "csv" {
			continue
		}
		data, err := readAll(tree, e.src)
		if err != nil {
			r.fail("note", e.src, "", err)
			continue
		}
		rows, _, err := parseCSV(data, ",")
		if err != nil || len(rows) == 0 {
			if err != nil {
				r.fail("note", e.src, "", err)
			}
			continue
		}
		header, body := rows[0], rows[1:]
		keys := columnKeys(header)
		csvDir := path.Dir(e.src)
		dbName := sanitizeName(spec.mapName(stemOf(e.src)))
		parent := strings.Join(segs(csvDir), "/")

		// pages of the rows: the folder next to the CSV that bears the database name
		pages := map[string]*entry{}
		for dir, m := range notesByDir {
			if path.Dir(dir) == csvDir && dir != csvDir && strings.EqualFold(sanitizeName(spec.mapName(path.Base(dir))), dbName) {
				for k, v := range m {
					pages[k] = v
				}
			}
		}
		indexDest, err := r.reserve(joinPath(parent, dbName+".md"))
		if err != nil {
			r.fail("note", e.src, "", err)
			continue
		}
		rw.register(indexDest, false)
		bySrc[e.src] = target{Dest: indexDest} // links to the database point at its index note
		r.setTotal(r.total + len(body) + 1)

		type rowOut struct {
			title string
			t     target
			rec   []string
		}
		var outs []rowOut
		type newNote struct {
			title, dest string
			props       []Prop
		}
		var fresh []newNote
		for _, rec := range body {
			title := ""
			if len(rec) > 0 {
				title = strings.TrimSpace(rec[0])
			}
			if title == "" {
				title = "Untitled"
			}
			props := rowProps(keys, rec, map[int]bool{0: true})
			if page, ok := pages[strings.ToLower(sanitizeName(title))]; ok {
				if len(props) > 0 {
					extra[page.src] = props
				}
				outs = append(outs, rowOut{title, bySrc[page.src], rec})
				continue
			}
			dest, err := r.reserve(joinPath(parent, dbName, sanitizeName(title)+".md"))
			if err != nil {
				r.fail("note", e.src+": "+title, "", err)
				continue
			}
			rw.register(dest, false)
			fresh = append(fresh, newNote{title, dest, props})
			outs = append(outs, rowOut{title, target{Dest: dest}, rec})
		}
		srcName := e.src
		post = append(post, func() error {
			for _, n := range fresh {
				if err := r.step(srcName + ": " + n.title); err != nil {
					return err
				}
				_ = r.writeNote(srcName+": "+n.title, n.title, n.dest, buildNote(n.props, "# "+n.title+"\n"))
			}
			if err := r.step(srcName); err != nil {
				return err
			}
			var b strings.Builder
			fmt.Fprintf(&b, "# %s\n\nIndex of the Notion database \"%s\" (%d rows).\n\n", dbName, dbName, len(outs))
			cols := len(keys)
			b.WriteString("| " + strings.Join(cellsOf(keys), " | ") + " |\n|" + strings.Repeat(" --- |", cols) + "\n")
			for i, o := range outs {
				if i >= 5000 {
					b.WriteString("\n_The table is truncated to the first 5000 rows._\n")
					break
				}
				row := make([]string, cols)
				for c := 0; c < cols; c++ {
					if c == 0 {
						row[c] = strings.ReplaceAll(rw.linkTo(indexDest, o.t, strings.ReplaceAll(o.title, "|", "-")), "|", "\\|")
					} else if c < len(o.rec) {
						row[c] = cell(strings.TrimSpace(o.rec[c]))
					}
				}
				b.WriteString("| " + strings.Join(row, " | ") + " |\n")
			}
			_ = r.writeNote(srcName, dbName, indexDest, buildNote([]Prop{{Key: "tags", Value: []string{"notion-database"}}}, b.String()))
			return nil
		})
	}
	return extra, post
}

func cellsOf(ss []string) []string {
	out := make([]string, len(ss))
	for i, s := range ss {
		out[i] = cell(s)
	}
	return out
}
