package drawing

import (
	"encoding/json"
	"strings"
	"testing"
)

// Generated with lz-string 1.5.0 (compressToBase64) from the JSON in `legacyPlain`.
const legacyPlain = `{"type":"excalidraw","version":2,"source":"https://excalidraw.com","elements":[{"id":"a1","type":"rectangle","x":0,"y":0,"width":10,"height":10,"text":"héllo ☃ 𝄞"}],"appState":{"viewBackgroundColor":"#fff"},"files":{}}`

const legacyCompressed = "N4IgLgngDgpiBcIYA8DGBDANgSwCYCd0B3EAGhADcZ8BnbAewDsEAmcm+gV31TkQAswYKDXgB6MSgw4CxAHSp6AWzJJMMJTEZgaCANqg8CEOgCMqyLGP4YqMOkYBzdauQIADOQgfyRPGH4EU08QfhhsR0EgkLAUMGN+AEvMTHoAAkBgMjTAFg3APF2QAF8AXXJ0KCgAZXtYhFAKbBgiACF0VABrR3wuRlwAYXpU/GMAYgAzccLyUex1XXhgAoKgA"

func TestLZDecompressBase64(t *testing.T) {
	got, err := LZDecompressBase64(legacyCompressed)
	if err != nil {
		t.Fatal(err)
	}
	if got != legacyPlain {
		t.Fatalf("decompressed text differs:\n got %q\nwant %q", got, legacyPlain)
	}
}

func TestLZDecompressRejectsGarbage(t *testing.T) {
	// Must neither panic nor loop: garbage either errors or yields something that is not the scene.
	for _, in := range []string{"", "!!!!", "AAAA", legacyCompressed[:40]} {
		if got, err := LZDecompressBase64(in); err == nil && got == legacyPlain {
			t.Errorf("%q decoded to the scene", in)
		}
	}
}

func note(block string) []byte {
	return []byte("---\nexcalidraw-plugin: parsed\n---\n# Excalidraw Data\n## Text Elements\nhello ^a1\n\n## Embedded Files\nimg1: [[pics/cat.png]]\nmissing: [[nope.png]]\n\n## Drawing\n" + block + "\n%%\n")
}

func TestConvertObsidianMD(t *testing.T) {
	images := func(link string) ([]byte, string, bool) {
		if link == "pics/cat.png" {
			return []byte{1, 2, 3}, "image/png", true
		}
		return nil, "", false
	}
	for name, block := range map[string]string{
		"compressed": "```compressed-json\n" + legacyCompressed[:60] + "\n" + legacyCompressed[60:] + "\n```",
		"plain":      "```json\n" + legacyPlain + "\n```",
	} {
		t.Run(name, func(t *testing.T) {
			out, err := ConvertObsidianMD(note(block), images)
			if err != nil {
				t.Fatal(err)
			}
			var s struct {
				Type     string `json:"type"`
				Elements []struct {
					ID string `json:"id"`
				} `json:"elements"`
				Files map[string]struct {
					MimeType string `json:"mimeType"`
					DataURL  string `json:"dataURL"`
				} `json:"files"`
			}
			if err := json.Unmarshal(out, &s); err != nil {
				t.Fatal(err)
			}
			if s.Type != "excalidraw" || len(s.Elements) != 1 || s.Elements[0].ID != "a1" {
				t.Fatalf("unexpected scene: %s", out)
			}
			if f := s.Files["img1"]; f.MimeType != "image/png" || f.DataURL != "data:image/png;base64,AQID" {
				t.Errorf("embedded image not inlined: %+v", f)
			}
			if _, ok := s.Files["missing"]; ok {
				t.Error("an unresolvable file must be skipped")
			}
			if !strings.Contains(string(out), "héllo") {
				t.Error("text lost")
			}
		})
	}
}

func TestConvertObsidianMDErrors(t *testing.T) {
	if _, err := ConvertObsidianMD([]byte("# just a note"), nil); err == nil {
		t.Error("a note without a drawing must be rejected")
	}
	if _, err := ConvertObsidianMD(note("```json\n{nope\n```"), nil); err == nil {
		t.Error("broken JSON must be rejected")
	}
}

func TestConvertObsidianMDFormulas(t *testing.T) {
	plain := `{"type":"excalidraw","elements":[` +
		`{"id":"f1","type":"image","fileId":"tex1","customData":{"keep":true},"versionNonce":2147483647},` +
		`{"id":"f2","type":"image","fileId":"other"}],"appState":{},"files":{}}`
	md := "## Embedded Files\ntex1: $$\\frac{a}{b}$$\n\n## Drawing\n```json\n" + plain + "\n```\n"
	out, err := ConvertObsidianMD([]byte(md), nil)
	if err != nil {
		t.Fatal(err)
	}
	var s struct {
		Elements []struct {
			ID         string `json:"id"`
			CustomData struct {
				Keep   bool `json:"keep"`
				Clarae struct {
					Kind  string `json:"kind"`
					Latex string `json:"latex"`
				} `json:"clarae"`
			} `json:"customData"`
		} `json:"elements"`
	}
	if err := json.Unmarshal(out, &s); err != nil {
		t.Fatal(err)
	}
	if m := s.Elements[0].CustomData.Clarae; m.Kind != "latex" || m.Latex != `\frac{a}{b}` {
		t.Errorf("formula not tagged: %s", out)
	}
	if !s.Elements[0].CustomData.Keep {
		t.Error("existing customData lost")
	}
	if s.Elements[1].CustomData.Clarae.Kind != "" {
		t.Error("an image that is not a formula was tagged")
	}
	if !strings.Contains(string(out), "2147483647") {
		t.Error("numbers must round-trip unchanged")
	}
}
