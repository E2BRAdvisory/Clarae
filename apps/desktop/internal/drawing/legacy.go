package drawing

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

// Import of the drawings of the Obsidian Excalidraw plugin (".excalidraw.md"): a Markdown note
// whose "## Drawing" section holds the scene as JSON, LZ-string compressed (```compressed-json)
// or plain (```json). The converter writes the standard Excalidraw JSON (Spec §2.7.1).

// base64Alphabet is the one of lz-string's compressToBase64.
const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="

// Bomb guards of the import. A few KB of compressed data can expand to hundreds of MB, so every
// step is bound: the note read, the decompressed scene (in UTF-8 bytes, which is what is then
// parsed) and the pretty-printed drawing, whose indentation grows with the nesting depth. The
// editor only warns above MaxSize, so the bounds leave room above it.
const (
	maxLegacyNote  = 2 * maxLegacyJSON // the ".excalidraw.md" note itself
	maxLegacyJSON  = 16 << 20          // the scene JSON, decompressed
	maxLegacyScene = 2 * maxLegacyJSON // the converted scene, indented (without the inlined images)
)

// MaxLegacyNoteSize is the largest ".excalidraw.md" note ConvertObsidianMD accepts.
const MaxLegacyNoteSize = maxLegacyNote

// errLegacyTooLarge is returned when a step of the conversion would exceed its bound.
var errLegacyTooLarge = errors.New("invalid: the drawing is too large to be imported")

// LZDecompressBase64 decodes lz-string's compressToBase64 output.
func LZDecompressBase64(input string) (string, error) {
	out, err := lzDecompressBase64(input, maxLegacyJSON)
	return string(out), err
}

// lzDecompressBase64 decodes lz-string's compressToBase64 output into UTF-8, refusing an output
// above limit bytes.
func lzDecompressBase64(input string, limit int) ([]byte, error) {
	var rev [256]int8
	for i := range rev {
		rev[i] = -1
	}
	for i := 0; i < len(base64Alphabet); i++ {
		rev[base64Alphabet[i]] = int8(i)
	}
	val := func(i int) int {
		if i >= len(input) {
			return 0
		}
		v := rev[input[i]]
		if v < 0 {
			return 0
		}
		return int(v)
	}
	return lzDecompress(len(input), 32, val, limit)
}

// lzNode is a dictionary entry of lzDecompress: the entry prev (-1: none) followed by unit. An
// entry is never copied, so the dictionary grows by a constant per code even when each entry is
// one unit longer than the previous one (the "KwKwK" case a bomb repeats).
type lzNode struct {
	prev   int32
	length int32
	unit   uint16
	first  uint16
}

// utf8Sink turns UTF-16 code units into UTF-8 as they come (a pair may span two dictionary
// entries), like utf16.Decode: an unpaired surrogate becomes U+FFFD.
type utf8Sink struct {
	out []byte
	hi  rune // pending high surrogate, 0 when none
}

func (s *utf8Sink) put(u uint16) {
	r := rune(u)
	if s.hi != 0 {
		if utf16.IsSurrogate(r) && r >= 0xDC00 {
			s.out = utf8.AppendRune(s.out, utf16.DecodeRune(s.hi, r))
			s.hi = 0
			return
		}
		s.out = utf8.AppendRune(s.out, utf8.RuneError)
		s.hi = 0
	}
	if r >= 0xD800 && r < 0xDC00 {
		s.hi = r
		return
	}
	s.out = utf8.AppendRune(s.out, r) // a lone low surrogate is written as U+FFFD
}

func (s *utf8Sink) close() []byte {
	if s.hi != 0 {
		s.out = utf8.AppendRune(s.out, utf8.RuneError)
		s.hi = 0
	}
	return s.out
}

// lzDecompress is lz-string's _decompress over UTF-16 code units, written out as UTF-8. limit
// bounds the output in bytes; the dictionary takes a constant size per code read, so the memory
// used is bound by the input and limit.
func lzDecompress(length, reset int, next func(int) int, limit int) ([]byte, error) {
	dict := make([]lzNode, 3, 64) // codes 0, 1, 2 are commands, never entries
	add := func(prev int, unit uint16) int {
		n := lzNode{prev: -1, length: 1, unit: unit, first: unit}
		if prev >= 0 {
			p := dict[prev]
			n = lzNode{prev: int32(prev), length: p.length + 1, unit: unit, first: p.first} //nolint:gosec // prev < len(dict), which limit keeps far below 2^31
		}
		dict = append(dict, n)
		return len(dict) - 1
	}
	var sink utf8Sink
	var scratch []uint16
	emit := func(code int) error {
		n := int(dict[code].length)
		if len(sink.out)+n-1 > limit { // n units are at least n-1 bytes of UTF-8
			return errLegacyTooLarge
		}
		scratch = slices.Grow(scratch[:0], n)[:n]
		for i, c := n-1, code; i >= 0; i-- {
			scratch[i] = dict[c].unit
			c = int(dict[c].prev)
		}
		for _, u := range scratch {
			sink.put(u)
		}
		if len(sink.out) > limit {
			return errLegacyTooLarge
		}
		return nil
	}
	enlargeIn, numBits := 4, 3
	cur, pos, idx := next(0), reset, 1
	read := func(n int) int {
		bits := 0
		for power := 1; power != 1<<n; power <<= 1 {
			if cur&pos > 0 {
				bits |= power
			}
			pos >>= 1
			if pos == 0 {
				pos = reset
				cur = next(idx)
				idx++
			}
		}
		return bits
	}
	var w int // the previous entry
	switch read(2) {
	case 0:
		w = add(-1, uint16(read(8)&0xFFFF))
	case 1:
		w = add(-1, uint16(read(16)&0xFFFF))
	default:
		return nil, nil
	}
	if err := emit(w); err != nil {
		return nil, err
	}
	for {
		if idx > length {
			return nil, errors.New("truncated compressed data")
		}
		code := read(numBits)
		switch code {
		case 0:
			code = add(-1, uint16(read(8)&0xFFFF))
			enlargeIn--
		case 1:
			code = add(-1, uint16(read(16)&0xFFFF))
			enlargeIn--
		case 2:
			return sink.close(), nil
		}
		if enlargeIn == 0 {
			enlargeIn = 1 << numBits
			numBits++
		}
		// The new entry is w followed by the first unit of the entry read; when the code is the
		// one being defined ("KwKwK"), that entry is w followed by its own first unit.
		var entry int
		switch {
		case code < len(dict) && code > 2:
			entry = code
			add(w, dict[code].first)
		case code == len(dict):
			entry = add(w, dict[w].first)
		default:
			return nil, errors.New("corrupt compressed data")
		}
		if err := emit(entry); err != nil {
			return nil, err
		}
		enlargeIn--
		w = entry
		if enlargeIn == 0 {
			enlargeIn = 1 << numBits
			numBits++
		}
	}
}

var (
	drawingBlockRe = regexp.MustCompile("(?s)```(compressed-json|json)[ \t]*\r?\n(.*?)```")
	// "id: $$\\frac{a}{b}$$" under "## Embedded Files": a formula of the plugin (its image is not stored).
	formulaRe  = regexp.MustCompile(`(?ms)^([A-Za-z0-9_-]+):\s*\$\$(.+?)\$\$[ \t]*$`)
	embeddedRe = regexp.MustCompile(`(?m)^([A-Za-z0-9_-]+):\s*!?\[\[([^\]]+)\]\]`)
)

// ImageReader returns the bytes of the vault file a "## Embedded Files" link names, and its MIME type.
type ImageReader func(link string) (data []byte, mime string, ok bool)

// ImageMIME is the image type of a file name ("" when it is not a supported image).
func ImageMIME(name string) string {
	switch strings.ToLower(path.Ext(name)) {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".svg":
		return "image/svg+xml"
	}
	return ""
}

// ConvertObsidianMD turns the text of an ".excalidraw.md" note into standard Excalidraw JSON.
// Images of "## Embedded Files" are read with `images` and stored in `files` as data URLs.
func ConvertObsidianMD(md []byte, images ImageReader) ([]byte, error) {
	if len(md) > maxLegacyNote {
		return nil, errLegacyTooLarge
	}
	text := string(md)
	from := 0
	if i := strings.Index(text, "## Drawing"); i >= 0 {
		from = i
	}
	m := drawingBlockRe.FindStringSubmatch(text[from:])
	if m == nil {
		return nil, errors.New("invalid: no drawing data found (expected a \"## Drawing\" section)")
	}
	var payload []byte
	if m[1] == "compressed-json" {
		clean := strings.Map(func(r rune) rune {
			if r == '\n' || r == '\r' || r == ' ' || r == '\t' {
				return -1
			}
			return r
		}, m[2])
		var err error
		if payload, err = lzDecompressBase64(clean, maxLegacyJSON); errors.Is(err, errLegacyTooLarge) {
			return nil, err
		} else if err != nil {
			return nil, fmt.Errorf("invalid: %w", err)
		}
	} else {
		if len(m[2]) > maxLegacyJSON {
			return nil, errLegacyTooLarge
		}
		payload = []byte(m[2])
	}
	var scene struct {
		Type     string                     `json:"type"`
		Version  int                        `json:"version"`
		Source   string                     `json:"source"`
		Elements json.RawMessage            `json:"elements"`
		AppState json.RawMessage            `json:"appState"`
		Files    map[string]json.RawMessage `json:"files"`
	}
	if err := json.Unmarshal(payload, &scene); err != nil {
		return nil, fmt.Errorf("invalid: the drawing data is not JSON: %w", err)
	}
	if len(scene.Elements) == 0 {
		return nil, errors.New("invalid: the drawing has no elements")
	}
	if scene.Files == nil {
		scene.Files = map[string]json.RawMessage{}
	}
	if formulas := formulaRe.FindAllStringSubmatch(text, -1); len(formulas) > 0 {
		tex := make(map[string]string, len(formulas))
		for _, m := range formulas {
			tex[m[1]] = strings.TrimSpace(m[2])
		}
		els, err := tagFormulas(scene.Elements, tex)
		if err != nil {
			return nil, err
		}
		scene.Elements = els
	}
	if len(scene.AppState) == 0 {
		scene.AppState = json.RawMessage(`{}`)
	}
	// Bound the pretty-printed scene before writing it: its indentation grows with the nesting
	// depth, so a small but deeply nested scene would expand far beyond its own size. The images
	// inlined below are bound by the caller's reader.
	size := indentedSize(scene.Elements, 1) + indentedSize(scene.AppState, 1)
	for id, f := range scene.Files {
		size += int64(len(id))*6 + indentedSize(f, 2)
	}
	if size > maxLegacyScene {
		return nil, errLegacyTooLarge
	}
	if images != nil {
		for _, e := range embeddedRe.FindAllStringSubmatch(text, -1) {
			id, link := e[1], e[2]
			if _, done := scene.Files[id]; done {
				continue
			}
			if i := strings.IndexAny(link, "#|"); i >= 0 {
				link = link[:i]
			}
			data, mime, ok := images(link)
			if !ok || mime == "" {
				continue
			}
			f, _ := json.Marshal(map[string]any{
				"id":       id,
				"mimeType": mime,
				"dataURL":  "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data),
				"created":  time.Now().UnixMilli(),
			})
			scene.Files[id] = f
		}
	}
	out := map[string]any{
		"type":     "excalidraw",
		"version":  2,
		"source":   "Clarae notanda",
		"elements": scene.Elements,
		"appState": scene.AppState,
		"files":    scene.Files,
	}
	return json.MarshalIndent(out, "", "  ")
}

// tagFormulas marks the image elements that show a formula with its TeX in
// `customData.clarae` ({kind: "latex"}), the way the editor's LaTeX command does. The rendered
// image is not converted here: the editor draws it when it opens the drawing.
//
// Only those elements are decoded as values; the others stay raw, so a large scene is not
// expanded into a tree of maps.
func tagFormulas(elements json.RawMessage, tex map[string]string) (json.RawMessage, error) {
	var els []json.RawMessage
	if err := json.Unmarshal(elements, &els); err != nil {
		return nil, fmt.Errorf("invalid: the drawing elements are not a list: %w", err)
	}
	for i, raw := range els {
		var head struct {
			Type   json.RawMessage `json:"type"`
			FileID json.RawMessage `json:"fileId"`
		}
		if err := json.Unmarshal(raw, &head); err != nil {
			return nil, fmt.Errorf("invalid: the drawing elements are not a list: %w", err)
		}
		var typ, id string
		_ = json.Unmarshal(head.Type, &typ)
		_ = json.Unmarshal(head.FileID, &id)
		src, ok := tex[id]
		if typ != "image" || !ok {
			continue
		}
		var e map[string]any
		dec := json.NewDecoder(bytes.NewReader(raw))
		dec.UseNumber()
		if err := dec.Decode(&e); err != nil {
			return nil, fmt.Errorf("invalid: the drawing elements are not a list: %w", err)
		}
		cd, _ := e["customData"].(map[string]any)
		if cd == nil {
			cd = map[string]any{}
		}
		cd["clarae"] = map[string]any{"kind": "latex", "latex": src, "w0": 0, "color": "#000000"}
		e["customData"] = cd
		tagged, err := json.Marshal(e)
		if err != nil {
			return nil, err
		}
		els[i] = tagged
	}
	size := 2 + len(els)
	for _, e := range els {
		size += len(e)
	}
	out := make([]byte, 0, size)
	out = append(out, '[')
	for i, e := range els {
		if i > 0 {
			out = append(out, ',')
		}
		out = append(out, e...)
	}
	return append(out, ']'), nil
}

// indentedSize is the size of raw once encoding/json has pretty-printed it with a two-space
// indent at depth (what MarshalIndent of the drawing does to it): whitespace outside strings is
// dropped, '<', '>', '&', U+2028 and U+2029 are escaped as \uXXXX, and every value of a
// non-empty object or array starts on its own indented line. raw must be valid JSON.
func indentedSize(raw []byte, depth int) int64 {
	const width = 2
	var n int64
	inString, escaped, opened := false, false, false
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		if inString {
			n++
			switch {
			case escaped:
				escaped = false
			case c == '\\':
				escaped = true
			case c == '"':
				inString = false
			case c == '<' || c == '>' || c == '&':
				n += 5 // <
			case c == 0xE2 && i+2 < len(raw) && raw[i+1] == 0x80 && (raw[i+2] == 0xA8 || raw[i+2] == 0xA9):
				n += 3 // three bytes become
			}
			continue
		}
		switch c {
		case ' ', '\t', '\r', '\n':
			continue
		}
		if opened {
			opened = false
			if c == '}' || c == ']' { // empty: "{}" or "[]" on one line
				depth--
				n++
				continue
			}
			n += 1 + int64(width*depth)
		}
		n++
		switch c {
		case '"':
			inString = true
		case '{', '[':
			depth++
			opened = true
		case '}', ']':
			depth--
			n += 1 + int64(width*depth)
		case ',':
			n += 1 + int64(width*depth)
		case ':':
			n++ // ": "
		}
	}
	return n
}
