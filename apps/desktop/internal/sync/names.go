package sync

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"memobrain/shared/pathrules"
)

// uniqueReserve is the room kept in a segment for the " (n)" suffix
// uniquePath may add to a conflict copy name.
const uniqueReserve = len(" (99999)")

// segmentBudget is the room left for the stem of the last segment of a path in
// dir, once ext and extra bytes are added (pathrules limits, §3.4.2).
func segmentBudget(dir, ext string, extra int) int {
	n := pathrules.MaxSegmentBytes - len(ext) - extra
	if dir != "" {
		n = min(n, pathrules.MaxPathBytes-len(dir)-1-len(ext)-extra)
	}
	return max(n, 1)
}

// truncateUTF8 cuts s to at most n bytes without splitting a character.
func truncateUTF8(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// uniquePath returns "name (1).ext", "name (2).ext", … the first one for which
// taken reports false. Used when a create collides with an existing path
// (§3.4.5 "il secondo diventa nome (1).md"). The stem is shortened when the
// suffix would make the name longer than the path rules allow.
func uniquePath(path string, taken func(string) bool) string {
	dir, base := pathrules.Split(path)
	ext := pathrules.Ext(base)
	stem := strings.TrimSuffix(base, ext)
	for n := 1; ; n++ {
		suffix := fmt.Sprintf(" (%d)", n)
		cand := truncateUTF8(stem, segmentBudget(dir, ext, len(suffix))) + suffix + ext
		if dir != "" {
			cand = dir + "/" + cand
		}
		if !taken(cand) {
			return cand
		}
	}
}

// conflictPath names the conflict copy: "<name> (conflitto <device> <YYYY-MM-DD HH-mm>).<ext>".
// The device name is reduced to characters every file system accepts, and the
// original name is shortened (never inside a character) so that the copy is a
// valid path even for names already close to the limits.
func conflictPath(path, device string, at time.Time, taken func(string) bool) string {
	dir, base := pathrules.Split(path)
	ext := pathrules.Ext(base)
	stem := strings.TrimSuffix(base, ext)
	device = sanitizeName(device)
	if device == "" {
		device = "dispositivo"
	}
	tag := fmt.Sprintf(" (conflitto %s %s)", device, at.Format("2006-01-02 15-04"))
	stem = truncateUTF8(stem, segmentBudget(dir, ext, len(tag)+uniqueReserve))
	cand := stem + tag + ext
	if dir != "" {
		cand = dir + "/" + cand
	}
	if !taken(cand) {
		return cand
	}
	return uniquePath(cand, taken)
}

// maxDeviceBytes bounds the device name inside a conflict copy name.
const maxDeviceBytes = 40

func sanitizeName(s string) string {
	var b strings.Builder
	for _, r := range strings.TrimSpace(s) {
		switch {
		case r < 0x20, r == 0x7f, r == utf8.RuneError, strings.ContainsRune(`\/:*?"<>|`, r):
			b.WriteRune('-')
		default:
			b.WriteRune(r)
		}
	}
	out := strings.TrimRight(b.String(), ". ")
	if len(out) > maxDeviceBytes {
		out = strings.TrimRight(truncateUTF8(out, maxDeviceBytes), ". ")
	}
	return out
}
