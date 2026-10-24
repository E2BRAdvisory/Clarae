package templates

import (
	"path"
	"strconv"
	"strings"
	"time"
)

// Defaults of the periodic and unique notes.
const (
	DefaultDailyFormat  = "YYYY-MM-DD"
	DefaultUniqueFormat = "YYYYMMDDHHmm"
)

func joinFolder(folder, name string) string {
	folder = strings.Trim(folder, "/")
	if folder == "" {
		return name
	}
	return folder + "/" + name
}

// DailyPath is the vault path of the daily note of day t. The format may contain
// '/' to nest notes in sub-folders ("YYYY/MM/YYYY-MM-DD").
func DailyPath(folder, format, lang string, t time.Time) string {
	if strings.TrimSpace(format) == "" {
		format = DefaultDailyFormat
	}
	return joinFolder(folder, FormatDate(t, format, lang)+".md")
}

// ParseDailyPath reads the day a daily-note path stands for (false when p is not a
// daily note under that folder and format).
func ParseDailyPath(p, folder, format, lang string, loc *time.Location) (time.Time, bool) {
	if strings.TrimSpace(format) == "" {
		format = DefaultDailyFormat
	}
	folder = strings.Trim(folder, "/")
	if folder != "" {
		rest, ok := strings.CutPrefix(p, folder+"/")
		if !ok {
			return time.Time{}, false
		}
		p = rest
	}
	stem, ok := strings.CutSuffix(p, path.Ext(p))
	if !ok || !strings.EqualFold(path.Ext(p), ".md") {
		return time.Time{}, false
	}
	return ParseDate(stem, format, lang, loc)
}

// AdjacentDay returns the day delta days after (negative: before) the day of the
// daily note p, formatted YYYY-MM-DD; "" when p is not a daily note.
func AdjacentDay(p, folder, format, lang string, delta int, loc *time.Location) string {
	t, ok := ParseDailyPath(p, folder, format, lang, loc)
	if !ok {
		return ""
	}
	return t.AddDate(0, 0, delta).Format("2006-01-02")
}

// UniquePath is the path of a new unique note stamped with now. When the path is
// taken (exists reports true) a numeric suffix is added: "202610241530 2.md".
func UniquePath(folder, format, lang string, now time.Time, exists func(string) bool) string {
	if strings.TrimSpace(format) == "" {
		format = DefaultUniqueFormat
	}
	stem := FormatDate(now, format, lang)
	if strings.TrimSpace(stem) == "" {
		stem = FormatDate(now, DefaultUniqueFormat, lang)
	}
	for n := 0; ; n++ {
		name := stem
		if n > 0 {
			name += " " + strconv.Itoa(n+1)
		}
		p := joinFolder(folder, name+".md")
		if !exists(p) {
			return p
		}
	}
}

// TitleOf is the note title of a vault path (file name without extension).
func TitleOf(p string) string { return strings.TrimSuffix(path.Base(p), path.Ext(p)) }
