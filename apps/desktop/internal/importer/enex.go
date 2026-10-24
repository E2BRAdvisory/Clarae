package importer

import (
	"bytes"
	"crypto/md5" //nolint:gosec // Evernote identifies resources by the MD5 of their data; not a security use
	"encoding/base64"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"path"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/net/html"
)

func init() {
	Register(&source{id: "enex", detect: func(p string) (bool, error) {
		return strings.EqualFold(filepath.Ext(p), ".enex"), nil
	}, exec: execENEX}, SourceInfo{Input: "file", Extensions: []string{"enex"}})
}

type enNote struct {
	Title   string   `xml:"title"`
	Created string   `xml:"created"`
	Updated string   `xml:"updated"`
	Tags    []string `xml:"tag"`
	Content string   `xml:"content"`
	Attrs   struct {
		SourceURL string `xml:"source-url"`
		Author    string `xml:"author"`
	} `xml:"note-attributes"`
	Resources []enResource `xml:"resource"`
}

type enResource struct {
	Data struct {
		Encoding string `xml:"encoding,attr"`
		Text     string `xml:",chardata"`
	} `xml:"data"`
	Mime  string `xml:"mime"`
	Attrs struct {
		FileName string `xml:"file-name"`
	} `xml:"resource-attributes"`
}

// countNotes counts "<note>" start tags without parsing (for the progress total).
func countNotes(rc io.Reader) int {
	const needle = "<note>"
	buf := make([]byte, 1<<20)
	carry := []byte{}
	n := 0
	for {
		k, err := rc.Read(buf)
		chunk := append(append([]byte{}, carry...), buf[:k]...)
		n += bytes.Count(chunk, []byte(needle))
		if len(chunk) >= len(needle) {
			carry = append([]byte{}, chunk[len(chunk)-len(needle)+1:]...)
		} else {
			carry = append([]byte{}, chunk...)
		}
		if err != nil {
			return n
		}
	}
}

func parseENTime(s string) (time.Time, bool) {
	t, err := time.Parse("20060102T150405Z", strings.TrimSpace(s))
	return t, err == nil
}

func execENEX(r *run, p string) error {
	if rc, err := openCapped(p, r.lim); err == nil {
		r.setTotal(countNotes(rc))
		_ = rc.Close()
	}
	rc, err := openCapped(p, r.lim)
	if err != nil {
		return err
	}
	defer func() { _ = rc.Close() }()
	// encoding/xml never resolves external entities or DTDs; the reader is size-capped.
	dec := xml.NewDecoder(rc)
	notes := 0
	for {
		tok, err := dec.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			if errors.Is(err, ErrTooLarge) {
				return err
			}
			if notes == 0 {
				return fmt.Errorf("invalid: not a valid ENEX file: %w", err)
			}
			r.warn("The file is damaged after note %d: %v", notes, err)
			break
		}
		se, ok := tok.(xml.StartElement)
		if !ok || se.Name.Local != "note" {
			continue
		}
		var n enNote
		if err := dec.DecodeElement(&n, &se); err != nil {
			if errors.Is(err, ErrTooLarge) {
				return err
			}
			r.warn("Note %d could not be read: %v", notes+1, err)
			break
		}
		notes++
		if err := r.step(n.Title); err != nil {
			return err
		}
		importENEXNote(r, notes, &n)
	}
	if notes == 0 {
		return errors.New("invalid: the ENEX file contains no notes")
	}
	return nil
}

func importENEXNote(r *run, idx int, n *enNote) {
	title := strings.TrimSpace(n.Title)
	if title == "" {
		title = "Untitled"
	}
	src := fmt.Sprintf("note %d: %s", idx, title)
	dest, err := r.reserve(sanitizeName(title) + ".md")
	if err != nil {
		r.fail("note", src, "", err)
		return
	}

	type media struct {
		dest, mime string
		used       bool
	}
	byHash := map[string]*media{}
	var order []*media
	for i := range n.Resources {
		res := &n.Resources[i]
		clean := strings.Map(func(r rune) rune {
			if r == ' ' || r == '\n' || r == '\r' || r == '\t' {
				return -1
			}
			return r
		}, res.Data.Text)
		data, err := base64.StdEncoding.DecodeString(clean)
		if err != nil {
			r.fail("attachment", fmt.Sprintf("%s: resource %d", src, i+1), "", fmt.Errorf("invalid base64 data: %w", err))
			continue
		}
		name := strings.TrimSpace(res.Attrs.FileName)
		ext := extForMIME(res.Mime)
		if name == "" {
			name = fmt.Sprintf("%s resource %d%s", sanitizeName(title), i+1, ext)
		} else if path.Ext(name) == "" {
			name += ext
		}
		d, err := r.putAttachment(fmt.Sprintf("%s: %s", src, name), name, data)
		if err != nil {
			continue
		}
		sum := md5.Sum(data) //nolint:gosec
		m := &media{dest: d, mime: res.Mime}
		byHash[hex.EncodeToString(sum[:])] = m
		order = append(order, m)
	}

	embed := func(m *media) string {
		isMedia := isImageExt(m.dest) || strings.HasPrefix(m.mime, "image/") || strings.HasPrefix(m.mime, "audio/") ||
			strings.HasPrefix(m.mime, "video/") || m.mime == "application/pdf"
		bang := ""
		if isMedia {
			bang = "!"
		}
		if r.opts.UseWikilinks {
			return bang + "[[" + path.Base(m.dest) + "]]"
		}
		return bang + "[" + path.Base(m.dest) + "](" + escapePath(relPath(path.Dir(dest), m.dest)) + ")"
	}
	cryptSeen := false
	res, err := htmlToMarkdown(n.Content, htmlHooks{
		Media: func(el *html.Node) string {
			if m, ok := byHash[strings.ToLower(attr(el, "hash"))]; ok {
				m.used = true
				return "\n\n" + embed(m) + "\n\n"
			}
			r.warn("%s: an attachment referenced in the text is missing from the export", src)
			return ""
		},
		Crypt: func() string {
			if !cryptSeen {
				cryptSeen = true
				r.warn("%s: encrypted text (en-crypt) was skipped", src)
			}
			return "> [!warning] Encrypted content omitted\n> Evernote encrypted text cannot be imported."
		},
	})
	if err != nil {
		r.fail("note", src, dest, err)
		return
	}
	for _, d := range res.Dropped {
		r.warn("%s: removed <%s> from the content for safety", src, d)
	}
	body := res.Markdown
	var rest []string
	for _, m := range order {
		if !m.used {
			rest = append(rest, "- "+strings.TrimPrefix(embed(m), "!"))
		}
	}
	if len(rest) > 0 {
		body += "\n\n## Attachments\n\n" + strings.Join(rest, "\n")
	}

	var props []Prop
	if t, ok := parseENTime(n.Created); ok {
		props = append(props, Prop{Key: "created", Value: isoTime(t)})
	}
	if t, ok := parseENTime(n.Updated); ok {
		props = append(props, Prop{Key: "updated", Value: isoTime(t)})
	}
	if tags := tagList(n.Tags); len(tags) > 0 {
		props = append(props, Prop{Key: "tags", Value: tags})
	}
	if u := strings.TrimSpace(n.Attrs.SourceURL); u != "" {
		props = append(props, Prop{Key: "source", Value: u})
	}
	if a := strings.TrimSpace(n.Attrs.Author); a != "" {
		props = append(props, Prop{Key: "author", Value: a})
	}
	_ = r.writeNote(src, title, dest, buildNote(props, body))
}
