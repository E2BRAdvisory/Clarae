package drawing

import (
	"encoding/json"
	"errors"
	"runtime"
	"strings"
	"testing"
)

// kwkwkBomb returns lz-string compressToBase64 data that decompresses to unit repeated: every code
// names the entry being defined ("KwKwK"), so each step outputs one unit more than the previous.
// A few KB expand quadratically.
func kwkwkBomb(unit uint16, steps int) string {
	var bits []bool
	put := func(v, n int) {
		for k := 0; k < n; k++ {
			bits = append(bits, v>>k&1 == 1)
		}
	}
	if unit < 256 {
		put(0, 2)
		put(int(unit), 8)
	} else {
		put(1, 2)
		put(int(unit), 16)
	}
	dictLen, enlargeIn, numBits := 4, 4, 3
	for range steps {
		put(dictLen, numBits)
		dictLen++
		enlargeIn--
		if enlargeIn == 0 {
			enlargeIn = 1 << numBits
			numBits++
		}
	}
	put(2, numBits)
	var sb strings.Builder
	for i := 0; i < len(bits); i += 6 {
		v := 0
		for k := 0; k < 6; k++ {
			v <<= 1
			if i+k < len(bits) && bits[i+k] {
				v |= 1
			}
		}
		sb.WriteByte(base64Alphabet[v])
	}
	return sb.String()
}

func TestKwKwKBombDecodes(t *testing.T) {
	// 1 + sum(k+1 for k=1..10) = 66 units
	got, err := LZDecompressBase64(kwkwkBomb('a', 10))
	if err != nil || got != strings.Repeat("a", 66) {
		t.Fatalf("got %d units, %v", len(got), err)
	}
	got, err = LZDecompressBase64(kwkwkBomb(0x20AC, 3))
	if err != nil || got != strings.Repeat("€", 10) {
		t.Fatalf("got %q, %v", got, err)
	}
}

// The bound is in UTF-8 bytes (what is parsed), not in UTF-16 units.
func TestLegacyBoundCountsBytes(t *testing.T) {
	bomb := kwkwkBomb(0x20AC, 3400) // ~5.8M units of '€': 17 MB of UTF-8
	if len(bomb) > 16<<10 {
		t.Fatalf("the bomb is %d bytes", len(bomb))
	}
	_, err := ConvertObsidianMD(note("```compressed-json\n"+bomb+"\n```"), nil)
	if err == nil || !strings.Contains(err.Error(), "too large") {
		t.Fatalf("a scene above the bound in bytes: %v", err)
	}
}

// A small input must not make the decompressor allocate far more than its bound.
func TestLegacyBombMemoryIsBound(t *testing.T) {
	bomb := kwkwkBomb('a', 12000) // ~72M units if fully expanded
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	_, err := LZDecompressBase64(bomb)
	runtime.ReadMemStats(&after)
	if err == nil || !strings.Contains(err.Error(), "too large") {
		t.Fatalf("the bomb was not refused: %v", err)
	}
	// TotalAlloc sums every growth of the output buffer (about 5x its final size for large
	// slices); without the bounds the same bomb allocates several hundred MB.
	if alloc := after.TotalAlloc - before.TotalAlloc; alloc > 8*maxLegacyJSON {
		t.Fatalf("decompressing a %d-byte bomb allocated %d MB", len(bomb), alloc>>20)
	}
}

// Deep nesting makes the indentation of the converted drawing grow quadratically.
func TestLegacyDeepNestingIsRefused(t *testing.T) {
	const depth = 5000
	elements := strings.Repeat("[", depth) + "1" + strings.Repeat("]", depth)
	scene := `{"type":"excalidraw","elements":[` + elements + `],"appState":{}}`
	_, err := ConvertObsidianMD(note("```json\n"+scene+"\n```"), nil)
	if !errors.Is(err, errLegacyTooLarge) {
		t.Fatalf("a %d-byte deeply nested scene: %v", len(scene), err)
	}
	if _, err := ConvertObsidianMD([]byte(strings.Repeat("x", maxLegacyNote+1)), nil); !errors.Is(err, errLegacyTooLarge) {
		t.Fatalf("an oversized note: %v", err)
	}
}

func TestIndentedSizeMatchesMarshalIndent(t *testing.T) {
	for _, raw := range []string{
		`{}`, `[]`, `1`, `"a<b>&c"`, `{"a": [1, 2, {"b": []}], "c": {}}`,
		"[ {\"x\" : \"\\\"q\\\\\" } ,\n\t[ [ ] , { } ] ]",
		`["line` + " " + `sep", "é ☃ 𝄞"]`,
		`{"elements":[{"id":"a1","type":"rectangle","x":0,"points":[[0,0],[1,1]]}]}`,
	} {
		for depth := range 3 {
			want, err := json.MarshalIndent(json.RawMessage(raw), strings.Repeat("  ", depth), "  ")
			if err != nil {
				t.Fatal(err)
			}
			// The prefix stands for the depth: like a nested value, the output does not start with it.
			if got := indentedSize([]byte(raw), depth); got != int64(len(want)) {
				t.Errorf("%q at depth %d: %d, want %d\n%s", raw, depth, got, len(want), want)
			}
		}
	}
}
