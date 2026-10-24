package importer

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

func init() {
	Register(&source{id: "roam", detect: detectRoam, exec: execRoam}, SourceInfo{Input: "file", Extensions: []string{"json"}})
}

type roamBlock struct {
	String   string      `json:"string"`
	UID      string      `json:"uid"`
	Heading  int         `json:"heading"`
	Children []roamBlock `json:"children"`
}

type roamPage struct {
	Title      string      `json:"title"`
	Children   []roamBlock `json:"children"`
	CreateTime int64       `json:"create-time"`
	EditTime   int64       `json:"edit-time"`
}

func detectRoam(p string) (bool, error) {
	if !strings.EqualFold(filepath.Ext(p), ".json") {
		return false, nil
	}
	f, err := os.Open(p)
	if err != nil {
		return false, err
	}
	defer func() { _ = f.Close() }()
	head := make([]byte, 64<<10)
	n, _ := f.Read(head)
	head = bytes.TrimSpace(head[:n])
	if len(head) == 0 || head[0] != '[' {
		return false, nil
	}
	return bytes.Contains(head, []byte(`"title"`)) && (bytes.Contains(head, []byte(`"children"`)) || bytes.Contains(head, []byte(`"uid"`))), nil
}

// eachRoamPage streams the pages of a Roam export one at a time.
func eachRoamPage(p string, lim Limits, fn func(roamPage) error) error {
	rc, err := openCapped(p, lim)
	if err != nil {
		return err
	}
	defer func() { _ = rc.Close() }()
	dec := json.NewDecoder(rc)
	tok, err := dec.Token()
	if err != nil {
		return fmt.Errorf("invalid: not a Roam JSON export: %w", err)
	}
	if d, ok := tok.(json.Delim); !ok || d != '[' {
		return errors.New("invalid: a Roam export is a JSON array of pages")
	}
	for dec.More() {
		var pg roamPage
		if err := dec.Decode(&pg); err != nil {
			if errors.Is(err, ErrTooLarge) {
				return err
			}
			return fmt.Errorf("invalid: Roam JSON: %w", err)
		}
		if err := fn(pg); err != nil {
			return err
		}
	}
	if _, err := dec.Token(); err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	return nil
}

var (
	roamMonths = "January|February|March|April|May|June|July|August|September|October|November|December"
	roamDayRe  = regexp.MustCompile(`^(` + roamMonths + `) (\d{1,2})(?:st|nd|rd|th), (\d{4})$`)
	roamLinkRe = regexp.MustCompile(`\[\[([^\[\]]+)\]\]`)
	roamTagRe  = regexp.MustCompile(`#\[\[([^\[\]]+)\]\]`)
	roamAlias  = regexp.MustCompile(`\[([^\[\]]+)\]\(\[\[([^\[\]]+)\]\]\)`)
	roamRefRe  = regexp.MustCompile(`\(\(([A-Za-z0-9_-]{6,12})\)\)`)
	roamHilite = regexp.MustCompile(`\^\^(.+?)\^\^`)
	roamItalic = regexp.MustCompile(`__(.+?)__`)
	roamTodo   = regexp.MustCompile(`^\{\{\[\[(TODO|DONE)\]\]\}\}\s*`)
	roamTodo2  = regexp.MustCompile(`^\{\{(TODO|DONE)\}\}\s*`)
	roamEmbed  = regexp.MustCompile(`\{\{\[?\[?embed\]?\]?:\s*(\(\([^)]*\)\))\s*\}\}`)
)

// roamDate converts "January 5th, 2024" to 2024-01-05.
func roamDate(title string) (string, bool) {
	m := roamDayRe.FindStringSubmatch(strings.TrimSpace(title))
	if m == nil {
		return "", false
	}
	t, err := time.Parse("January 2 2006", m[1]+" "+m[2]+" "+m[3])
	if err != nil {
		return "", false
	}
	return t.Format("2006-01-02"), true
}

func roamName(title string) string {
	if d, ok := roamDate(title); ok {
		return d
	}
	return sanitizeName(title)
}

type roamConv struct {
	refs       map[string]string
	refsPlain  int
	refsLost   int
	components int
}

func (c *roamConv) text(s string, topLevelTask *string) string {
	for _, rx := range []*regexp.Regexp{roamTodo, roamTodo2} {
		if m := rx.FindStringSubmatch(s); m != nil && topLevelTask != nil {
			*topLevelTask = map[string]string{"TODO": "[ ] ", "DONE": "[x] "}[m[1]]
			s = rx.ReplaceAllString(s, "")
		}
	}
	s = roamEmbed.ReplaceAllString(s, "$1")
	s = roamRefRe.ReplaceAllStringFunc(s, func(m string) string {
		uid := roamRefRe.FindStringSubmatch(m)[1]
		if t, ok := c.refs[uid]; ok {
			c.refsPlain++
			return t
		}
		c.refsLost++
		return ""
	})
	s = roamAlias.ReplaceAllStringFunc(s, func(m string) string {
		sm := roamAlias.FindStringSubmatch(m)
		return "[[" + roamName(sm[2]) + "|" + strings.ReplaceAll(sm[1], "|", "-") + "]]"
	})
	s = roamTagRe.ReplaceAllString(s, "[[$1]]")
	s = roamLinkRe.ReplaceAllStringFunc(s, func(m string) string {
		title := roamLinkRe.FindStringSubmatch(m)[1]
		name := roamName(title)
		if name == title || strings.Contains(title, "|") {
			return m
		}
		return "[[" + name + "|" + title + "]]"
	})
	s = roamHilite.ReplaceAllString(s, "==$1==")
	s = roamItalic.ReplaceAllString(s, "*$1*")
	if strings.Contains(s, "{{") {
		c.components++
	}
	return s
}

// plainRef flattens a block's text for use in a block reference.
func plainRef(s string) string {
	s = roamTodo.ReplaceAllString(s, "")
	s = roamAlias.ReplaceAllString(s, "$1")
	s = roamTagRe.ReplaceAllString(s, "$1")
	s = roamRefRe.ReplaceAllString(s, "")
	return strings.TrimSpace(strings.ReplaceAll(s, "\n", " "))
}

func (c *roamConv) blocks(b *strings.Builder, blocks []roamBlock, depth int) {
	for _, bl := range blocks {
		task := ""
		txt := c.text(bl.String, &task)
		if bl.Heading >= 1 && bl.Heading <= 3 {
			txt = strings.Repeat("#", bl.Heading) + " " + txt
		}
		indent := strings.Repeat("\t", depth)
		lines := strings.Split(strings.ReplaceAll(txt, "\r\n", "\n"), "\n")
		b.WriteString(indent + "- " + task + lines[0] + "\n")
		for _, l := range lines[1:] {
			b.WriteString(indent + "  " + l + "\n")
		}
		c.blocks(b, bl.Children, depth+1)
	}
}

func collectRefs(blocks []roamBlock, refs map[string]string) {
	for _, bl := range blocks {
		if bl.UID != "" && bl.String != "" {
			refs[bl.UID] = plainRef(bl.String)
		}
		collectRefs(bl.Children, refs)
	}
}

func execRoam(r *run, p string) error {
	refs := map[string]string{}
	pages := 0
	if err := eachRoamPage(p, r.lim, func(pg roamPage) error {
		pages++
		collectRefs(pg.Children, refs)
		return nil
	}); err != nil {
		return err
	}
	r.setTotal(pages)
	c := &roamConv{refs: refs}
	err := eachRoamPage(p, r.lim, func(pg roamPage) error {
		title := strings.TrimSpace(pg.Title)
		if err := r.step(title); err != nil {
			return err
		}
		if title == "" {
			r.skip("note", "(untitled page)", "page without a title")
			return nil
		}
		if len(pg.Children) == 0 {
			r.skip("note", title, "empty page")
			return nil
		}
		var b strings.Builder
		c.blocks(&b, pg.Children, 0)
		var props []Prop
		if pg.CreateTime > 0 {
			props = append(props, Prop{Key: "created", Value: isoTime(time.UnixMilli(pg.CreateTime))})
		}
		if pg.EditTime > 0 {
			props = append(props, Prop{Key: "updated", Value: isoTime(time.UnixMilli(pg.EditTime))})
		}
		name := roamName(title)
		if _, ok := roamDate(title); ok {
			props = append(props, Prop{Key: "tags", Value: []string{"daily-note"}})
		}
		_ = r.putNote(title, name, "", name, buildNote(props, b.String()))
		return nil
	})
	if err != nil {
		return err
	}
	if c.refsPlain+c.refsLost > 0 {
		r.warn("%d block reference(s) were converted to plain text%s",
			c.refsPlain+c.refsLost, map[bool]string{true: ", " + strconv.Itoa(c.refsLost) + " could not be resolved and were removed", false: ""}[c.refsLost > 0])
	}
	if c.components > 0 {
		r.warn("%d block(s) use Roam components ({{...}}) that were left as text", c.components)
	}
	return nil
}
