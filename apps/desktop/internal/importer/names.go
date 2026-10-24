package importer

import (
	"net/url"
	"path"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

const maxNameBytes = 120 // leaves room for " (n)" and the extension within pathrules' segment limit

// sanitizeName turns arbitrary text (a note title, an archive entry name) into one safe
// file-name segment without extension: no separators, no characters the vault path rules or
// wikilinks reject, no reserved names, never empty.
func sanitizeName(s string) string {
	s = norm.NFC.String(s)
	var b strings.Builder
	for _, r := range s {
		switch {
		case r < 0x20 || r == 0x7f || r == utf8.RuneError:
			b.WriteByte(' ')
		case strings.ContainsRune("\\/:*?\"<>|#^[]", r):
			b.WriteByte('-')
		default:
			b.WriteRune(r)
		}
	}
	out := strings.Join(strings.Fields(b.String()), " ")
	out = strings.Trim(out, ". ")
	if len(out) > maxNameBytes {
		cut := maxNameBytes
		for cut > 0 && !utf8.RuneStart(out[cut]) {
			cut--
		}
		out = strings.Trim(out[:cut], ". ")
	}
	if out == "" {
		return "Untitled"
	}
	base := out
	if i := strings.IndexByte(out, '.'); i >= 0 {
		base = out[:i]
	}
	switch strings.ToUpper(base) {
	case "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
		"LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9":
		out += "_"
	}
	return out
}

// sanitizeFile sanitizes a file name keeping a short extension.
func sanitizeFile(name string) string {
	ext := strings.ToLower(path.Ext(name))
	if len(ext) > 12 || strings.ContainsAny(ext, " #^[]\\:*?\"<>|") {
		ext = ""
	}
	return sanitizeName(strings.TrimSuffix(name, path.Ext(name))) + ext
}

func stemOf(p string) string {
	b := path.Base(p)
	return strings.TrimSuffix(b, path.Ext(b))
}

func joinPath(parts ...string) string {
	var segs []string
	for _, p := range parts {
		p = strings.Trim(p, "/")
		if p != "" {
			segs = append(segs, p)
		}
	}
	return strings.Join(segs, "/")
}

// escapePath percent-encodes each segment of a vault path for a Markdown link destination.
func escapePath(p string) string {
	segs := strings.Split(p, "/")
	for i, s := range segs {
		segs[i] = url.PathEscape(s)
	}
	return strings.Join(segs, "/")
}

// relPath returns target relative to the folder dir (both vault paths).
func relPath(dir, target string) string {
	var d []string
	if dir = strings.Trim(dir, "/"); dir != "" {
		d = strings.Split(dir, "/")
	}
	t := strings.Split(target, "/")
	i := 0
	for i < len(d) && i < len(t)-1 && d[i] == t[i] {
		i++
	}
	var out []string
	for j := i; j < len(d); j++ {
		out = append(out, "..")
	}
	out = append(out, t[i:]...)
	return strings.Join(out, "/")
}

var mimeExt = map[string]string{
	"image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/gif": ".gif", "image/webp": ".webp",
	"image/svg+xml": ".svg", "image/bmp": ".bmp", "image/tiff": ".tiff", "image/heic": ".heic",
	"application/pdf": ".pdf", "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/wav": ".wav", "audio/x-wav": ".wav",
	"audio/amr": ".amr", "audio/ogg": ".ogg", "video/mp4": ".mp4", "video/quicktime": ".mov", "video/3gpp": ".3gp",
	"application/zip": ".zip", "text/plain": ".txt", "text/html": ".html", "text/csv": ".csv",
	"application/msword": ".doc", "application/vnd.ms-excel": ".xls", "application/vnd.ms-powerpoint": ".ppt",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document":   ".docx",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":         ".xlsx",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
}

// extForMIME maps a MIME type to a file extension (".bin" when unknown).
func extForMIME(m string) string {
	m = strings.ToLower(strings.TrimSpace(m))
	if i := strings.IndexByte(m, ';'); i >= 0 {
		m = strings.TrimSpace(m[:i])
	}
	if e, ok := mimeExt[m]; ok {
		return e
	}
	return ".bin"
}

func isImageExt(name string) bool {
	switch strings.ToLower(path.Ext(name)) {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".tiff", ".heic", ".avif":
		return true
	}
	return false
}
