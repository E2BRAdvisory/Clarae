package importer

import (
	"bytes"
	"path"
	"slices"
	"strings"
	"time"

	"golang.org/x/net/html"
)

// Google Keep notes exported as HTML (Takeout writes one .html per note next to the .json;
// older exports, and some partial ones, have the HTML only). A note with both is read from
// its JSON; an HTML without a JSON sibling is read here into the same keepNote, so the rest
// of the import (attachments, labels, links, properties) is shared.
//
//	<div class="note YELLOW">
//	  <div class="heading"><div class="meta-icons"><span class="pinned" …></span></div>Jan 4, 2024, 10:00:00 AM</div>
//	  <div class="title">Groceries</div>
//	  <div class="content">text<br>more</div>
//	  <div class="listitem"><div class="bullet">&#9745;</div><div class="text">Milk</div></div>
//	  <div class="attachments"><ul><li><img src="photo.jpg"></li></ul></div>
//	  <div class="chips"><span class="chip label"><span class="label-name">home</span></span>
//	    <span class="chip annotation"><a href="https://…"><span class="annotation-title">…</span></a></span></div>
//	</div>

func looksLikeKeepHTML(data []byte) bool {
	return bytes.Contains(data, []byte(`class="note`)) &&
		(bytes.Contains(data, []byte(`class="content"`)) || bytes.Contains(data, []byte(`class="title"`)) ||
			bytes.Contains(data, []byte(`class="listitem`)))
}

// keepHTMLDates are the layouts of the heading date seen in Takeout exports (US English and
// day-first locales).
var keepHTMLDates = []string{
	"Jan 2, 2006, 3:04:05 PM",
	"Jan 2, 2006, 3:04:05 PM MST",
	"2 Jan 2006, 15:04:05",
	"02 Jan 2006, 15:04:05",
	"Jan 2, 2006 3:04:05 PM",
}

func classes(n *html.Node) []string { return strings.Fields(attr(n, "class")) }

func hasClass(n *html.Node, c string) bool { return slices.Contains(classes(n), c) }

// walkElements calls fn for every element below n, depth first; fn returns false to skip its children.
func walkElements(n *html.Node, fn func(*html.Node) bool) {
	for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
		if ch.Type == html.ElementNode && !fn(ch) {
			continue
		}
		walkElements(ch, fn)
	}
}

func innerHTML(n *html.Node) string {
	var b strings.Builder
	for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
		_ = html.Render(&b, ch)
	}
	return b.String()
}

func keepMimetype(p string) string {
	ext := strings.TrimPrefix(strings.ToLower(path.Ext(p)), ".")
	switch ext {
	case "jpg":
		return "image/jpeg"
	case "jpeg", "png", "gif", "webp":
		return "image/" + ext
	case "3gp", "m4a", "mp3", "amr", "ogg", "wav":
		return "audio/" + ext
	}
	return ""
}

// parseKeepHTML reads a note page; ok is false when it is not a Keep note.
func parseKeepHTML(data []byte) (keepNote, bool) {
	var kn keepNote
	if !looksLikeKeepHTML(data) || len(data) > maxHTMLBytes {
		return kn, false
	}
	doc, err := html.Parse(bytes.NewReader(data))
	if err != nil {
		return kn, false
	}
	var note *html.Node
	walkElements(doc, func(n *html.Node) bool {
		if note == nil && n.Data == "div" && hasClass(n, "note") {
			note = n
			return false
		}
		return note == nil
	})
	if note == nil {
		return kn, false
	}
	for _, c := range classes(note) {
		if c != "note" {
			kn.Color = c
		}
	}
	walkElements(note, func(n *html.Node) bool {
		switch {
		case hasClass(n, "heading"):
			var date strings.Builder
			for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
				if ch.Type == html.TextNode {
					date.WriteString(ch.Data)
				}
			}
			kn.UserEditedTimestampUsec = keepHTMLDate(date.String())
			walkElements(n, func(icon *html.Node) bool {
				kn.IsPinned = kn.IsPinned || hasClass(icon, "pinned")
				kn.IsArchived = kn.IsArchived || hasClass(icon, "archived")
				kn.IsTrashed = kn.IsTrashed || hasClass(icon, "trashed")
				return true
			})
			return false
		case hasClass(n, "title"):
			kn.Title = strings.TrimSpace(textOf(n))
			return false
		case hasClass(n, "content"):
			if res, err := htmlToMarkdown("<body>"+innerHTML(n)+"</body>", htmlHooks{}); err == nil {
				kn.TextContent = strings.TrimSpace(res.Markdown)
			}
			return false
		case hasClass(n, "listitem"):
			item := struct {
				Text      string `json:"text"`
				IsChecked bool   `json:"isChecked"`
			}{IsChecked: hasClass(n, "checked")}
			walkElements(n, func(part *html.Node) bool {
				if hasClass(part, "bullet") && strings.Contains(textOf(part), "☑") {
					item.IsChecked = true
				}
				if hasClass(part, "text") {
					item.Text = strings.TrimSpace(textOf(part))
				}
				return true
			})
			kn.ListContent = append(kn.ListContent, item)
			return false
		case hasClass(n, "label-name"):
			kn.Labels = append(kn.Labels, struct {
				Name string `json:"name"`
			}{Name: strings.TrimSpace(textOf(n))})
			return false
		case hasClass(n, "annotation"):
			walkElements(n, func(a *html.Node) bool {
				if a.Data == "a" && attr(a, "href") != "" {
					title := strings.TrimSpace(textOf(a))
					kn.Annotations = append(kn.Annotations, struct {
						URL         string `json:"url"`
						Title       string `json:"title"`
						Description string `json:"description"`
					}{URL: attr(a, "href"), Title: title})
				}
				return true
			})
			return false
		case n.Data == "img" || n.Data == "audio" || n.Data == "source":
			if src := attr(n, "src"); src != "" && !strings.Contains(src, ":") {
				kn.Attachments = append(kn.Attachments, struct {
					FilePath string `json:"filePath"`
					Mimetype string `json:"mimetype"`
				}{FilePath: src, Mimetype: keepMimetype(src)})
			}
		}
		return true
	})
	return kn, true
}

// keepHTMLDate parses the heading date into microseconds (0 when it cannot be read). Recent
// exports put a narrow no-break space before AM/PM.
func keepHTMLDate(s string) int64 {
	s = strings.Join(strings.Fields(strings.NewReplacer(" ", " ", " ", " ").Replace(s)), " ")
	for _, layout := range keepHTMLDates {
		if t, err := time.ParseInLocation(layout, s, time.Local); err == nil {
			return t.UnixMicro()
		}
	}
	return 0
}
