package templates

import (
	"regexp"
	"strings"
	"time"
)

// Default layouts of {{date}} and {{time}}.
const (
	DefaultDateFormat = "YYYY-MM-DD"
	DefaultTimeFormat = "HH:mm"
)

// ExpandOptions are the values a template is expanded with.
type ExpandOptions struct {
	// Now is the moment {{date}} and {{time}} refer to.
	Now time.Time
	// Title is the note's title for {{title}}.
	Title string
	// Lang selects month and weekday names ("en", "it").
	Lang string
}

var variableRe = regexp.MustCompile(`\{\{\s*(date|time|title)\s*(?::([^{}\n]*))?\}\}`)

// Expand replaces {{date}}, {{date:FORMAT}}, {{time}}, {{time:FORMAT}} and {{title}}
// in src. Unknown variables (and anything else in braces) are left literally, so
// templates written for other tools survive untouched.
func Expand(src string, o ExpandOptions) string {
	return variableRe.ReplaceAllStringFunc(src, func(m string) string {
		sub := variableRe.FindStringSubmatch(m)
		name, layout := sub[1], strings.TrimSpace(sub[2])
		switch name {
		case "title":
			if layout != "" {
				return m // {{title:x}} is not a variable
			}
			return o.Title
		case "date":
			if strings.TrimSpace(layout) == "" {
				layout = DefaultDateFormat
			}
		default:
			if strings.TrimSpace(layout) == "" {
				layout = DefaultTimeFormat
			}
		}
		return FormatDate(o.Now, layout, o.Lang)
	})
}
