package sync

import (
	"fmt"
	"strings"
	"time"

	"memobrain/shared/pathrules"
)

// uniquePath returns "name (1).ext", "name (2).ext", … the first one for which
// taken reports false. Used when a create collides with an existing path
// (§3.4.5 "il secondo diventa nome (1).md").
func uniquePath(path string, taken func(string) bool) string {
	dir, base := pathrules.Split(path)
	ext := pathrules.Ext(base)
	stem := strings.TrimSuffix(base, ext)
	for n := 1; ; n++ {
		cand := fmt.Sprintf("%s (%d)%s", stem, n, ext)
		if dir != "" {
			cand = dir + "/" + cand
		}
		if !taken(cand) {
			return cand
		}
	}
}

// conflictPath names the conflict copy: "<name> (conflitto <device> <YYYY-MM-DD HH-mm>).<ext>".
// The device name is reduced to characters every file system accepts.
func conflictPath(path, device string, at time.Time, taken func(string) bool) string {
	dir, base := pathrules.Split(path)
	ext := pathrules.Ext(base)
	stem := strings.TrimSuffix(base, ext)
	device = sanitizeName(device)
	if device == "" {
		device = "dispositivo"
	}
	name := fmt.Sprintf("%s (conflitto %s %s)", stem, device, at.Format("2006-01-02 15-04"))
	cand := name + ext
	if dir != "" {
		cand = dir + "/" + cand
	}
	if !taken(cand) {
		return cand
	}
	return uniquePath(cand, taken)
}

func sanitizeName(s string) string {
	var b strings.Builder
	for _, r := range strings.TrimSpace(s) {
		switch {
		case r < 0x20, strings.ContainsRune(`\/:*?"<>|`, r):
			b.WriteRune('-')
		default:
			b.WriteRune(r)
		}
	}
	out := strings.TrimRight(b.String(), ". ")
	if len(out) > 40 {
		out = strings.TrimRight(out[:40], ". ")
	}
	return out
}
