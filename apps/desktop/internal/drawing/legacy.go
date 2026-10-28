package drawing

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"regexp"
	"strings"
	"time"
	"unicode/utf16"
)

// Import of the drawings of the Obsidian Excalidraw plugin (".excalidraw.md"): a Markdown note
// whose "## Drawing" section holds the scene as JSON, LZ-string compressed (```compressed-json)
// or plain (```json). The converter writes the standard Excalidraw JSON (Spec §2.7.1).

// base64Alphabet is the one of lz-string's compressToBase64.
const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="

// maxLegacyJSON bounds the decompressed scene (a bomb guard); the vault's own drawing limit is 10 MB.
const maxLegacyJSON = 64 << 20

// LZDecompressBase64 decodes lz-string's compressToBase64 output.
func LZDecompressBase64(input string) (string, error) {
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
	units, err := lzDecompress(len(input), 32, val)
	if err != nil {
		return "", err
	}
	return string(utf16.Decode(units)), nil
}

// lzDecompress is lz-string's _decompress over UTF-16 code units.
func lzDecompress(length, reset int, next func(int) int) ([]uint16, error) {
	var dict [][]uint16
	dict = append(dict, []uint16{0}, []uint16{1}, []uint16{2})
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
	var c []uint16
	switch read(2) {
	case 0:
		c = []uint16{uint16(read(8))}
	case 1:
		c = []uint16{uint16(read(16))}
	default:
		return nil, nil
	}
	dict = append(dict, c)
	w := c
	out := append([]uint16(nil), c...)
	for {
		if idx > length {
			return nil, errors.New("truncated compressed data")
		}
		code := read(numBits)
		switch code {
		case 0:
			dict = append(dict, []uint16{uint16(read(8))})
			code = len(dict) - 1
			enlargeIn--
		case 1:
			dict = append(dict, []uint16{uint16(read(16))})
			code = len(dict) - 1
			enlargeIn--
		case 2:
			return out, nil
		}
		if enlargeIn == 0 {
			enlargeIn = 1 << numBits
			numBits++
		}
		var entry []uint16
		switch {
		case code < len(dict) && dict[code] != nil:
			entry = dict[code]
		case code == len(dict):
			entry = append(append([]uint16(nil), w...), w[0])
		default:
			return nil, errors.New("corrupt compressed data")
		}
		out = append(out, entry...)
		if len(out) > maxLegacyJSON {
			return nil, errors.New("compressed scene is too large")
		}
		dict = append(dict, append(append([]uint16(nil), w...), entry[0]))
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
	embeddedRe     = regexp.MustCompile(`(?m)^([A-Za-z0-9_-]+):\s*!?\[\[([^\]]+)\]\]`)
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
	text := string(md)
	from := 0
	if i := strings.Index(text, "## Drawing"); i >= 0 {
		from = i
	}
	m := drawingBlockRe.FindStringSubmatch(text[from:])
	if m == nil {
		return nil, errors.New("invalid: no drawing data found (expected a \"## Drawing\" section)")
	}
	payload := m[2]
	if m[1] == "compressed-json" {
		clean := strings.Map(func(r rune) rune {
			if r == '\n' || r == '\r' || r == ' ' || r == '\t' {
				return -1
			}
			return r
		}, payload)
		var err error
		if payload, err = LZDecompressBase64(clean); err != nil {
			return nil, fmt.Errorf("invalid: %w", err)
		}
	}
	var scene struct {
		Type     string                     `json:"type"`
		Version  int                        `json:"version"`
		Source   string                     `json:"source"`
		Elements json.RawMessage            `json:"elements"`
		AppState json.RawMessage            `json:"appState"`
		Files    map[string]json.RawMessage `json:"files"`
	}
	if err := json.Unmarshal([]byte(payload), &scene); err != nil {
		return nil, fmt.Errorf("invalid: the drawing data is not JSON: %w", err)
	}
	if len(scene.Elements) == 0 {
		return nil, errors.New("invalid: the drawing has no elements")
	}
	if scene.Files == nil {
		scene.Files = map[string]json.RawMessage{}
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
	if len(scene.AppState) == 0 {
		scene.AppState = json.RawMessage(`{}`)
	}
	out := map[string]any{
		"type":     "excalidraw",
		"version":  2,
		"source":   "MemoBrain Notes",
		"elements": scene.Elements,
		"appState": scene.AppState,
		"files":    scene.Files,
	}
	return json.MarshalIndent(out, "", "  ")
}
