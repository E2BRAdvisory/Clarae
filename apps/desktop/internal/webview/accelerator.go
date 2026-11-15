package webview

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// An accelerator is a key combination written in lower case, tokens joined with "+": the modifiers
// in the order ctrl, alt, shift, cmd (cmd is the Command key of a Mac), then the key:
//
//	cmd+w   ctrl+shift+tab   cmd+alt+left   f5
//
// The key is one printable ASCII character (the letter or digit, lower case; "plus" for "+"), or a
// name: enter, escape, tab, space, backspace, delete, up, down, left, right, home, end, pageup,
// pagedown, f1 to f20. It is the character the key produces, not its place on the keyboard.
//
// A guest keeps typing: a combination that the page needs to read what the user writes is refused. It
// must hold ctrl or cmd (a function key may stand alone), and the shortcuts of text editing (cmd+c,
// cmd+v, cmd+x, cmd+a, cmd+z, cmd+shift+z) cannot be reserved.

// MaxAccelerators bounds the list of ReserveKeys.
const MaxAccelerators = 128

// ErrAccelerator is wrapped by the errors of ParseAccelerator and Manager.ReserveKeys.
var ErrAccelerator = errors.New("invalid accelerator")

var modifierOrder = []string{"ctrl", "alt", "shift", "cmd"}

var namedKeys = map[string]bool{
	"enter": true, "escape": true, "tab": true, "space": true, "backspace": true, "delete": true,
	"up": true, "down": true, "left": true, "right": true, "home": true, "end": true,
	"pageup": true, "pagedown": true, "plus": true,
}

func init() {
	for i := 1; i <= 20; i++ {
		namedKeys["f"+strconv.Itoa(i)] = true
	}
}

// editing are the shortcuts a text field of the page needs.
var editing = map[string]bool{
	"cmd+c": true, "cmd+v": true, "cmd+x": true, "cmd+a": true, "cmd+z": true, "shift+cmd+z": true,
}

// ParseAccelerator checks an accelerator and returns it in the canonical form (see above). Case and
// the order of the modifiers are accepted as they come; the canonical form is what a driver compares.
func ParseAccelerator(s string) (string, error) {
	fail := func(why string) (string, error) {
		return "", fmt.Errorf("%w: %s", ErrAccelerator, why)
	}
	if s == "" || len(s) > 32 {
		return fail("empty or too long")
	}
	parts := strings.Split(strings.ToLower(s), "+")
	// "cmd++" spells the plus key with a bare "+": the split leaves two empty tokens.
	if n := len(parts); n >= 2 && parts[n-1] == "" && parts[n-2] == "" {
		parts = append(parts[:n-2], "plus")
	}
	key := parts[len(parts)-1]
	mods := map[string]bool{}
	for _, m := range parts[:len(parts)-1] {
		ok := false
		for _, known := range modifierOrder {
			ok = ok || m == known
		}
		if !ok {
			return fail("unknown modifier " + strconv.Quote(m))
		}
		if mods[m] {
			return fail("modifier " + m + " twice")
		}
		mods[m] = true
	}
	switch {
	case namedKeys[key]:
	case len(key) == 1 && key[0] > ' ' && key[0] < 0x7f && key != "+":
	default:
		return fail("unknown key " + strconv.Quote(key))
	}
	fkey := len(key) >= 2 && key[0] == 'f' && key[1] >= '0' && key[1] <= '9'
	if !mods["ctrl"] && !mods["cmd"] && !fkey {
		return fail("ctrl or cmd is required")
	}
	var out []string
	for _, m := range modifierOrder {
		if mods[m] {
			out = append(out, m)
		}
	}
	canonical := strings.Join(append(out, key), "+")
	if editing[canonical] {
		return fail(canonical + " is text editing")
	}
	return canonical, nil
}

// DataStoreID is the identifier of the session data of the applications of a vault: a UUID derived
// from the id of the vault, so it is the same at every start and never shared with another vault.
// The data live where the engine of the platform keeps them (on macOS the website data store of
// WebKit, in the container of the application), not in a folder of ours, and are never part of the
// vault or of its synchronization.
func DataStoreID(vaultID string) string {
	sum := sha256.Sum256([]byte("clarae/webview/data-store/v1\x00" + vaultID))
	b := sum[:16]
	b[6] = b[6]&0x0f | 0x50 // version 5 layout: a name-based UUID
	b[8] = b[8]&0x3f | 0x80 // RFC 4122 variant
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
