package merge

import (
	"strings"

	"github.com/sergi/go-diff/diffmatchpatch"
)

// splitLines splits keeping the line terminators, so that joining the pieces
// reproduces the input byte for byte (CRLF, missing final newline).
func splitLines(s string) []string {
	if s == "" {
		return nil
	}
	ls := strings.SplitAfter(s, "\n")
	if ls[len(ls)-1] == "" {
		ls = ls[:len(ls)-1]
	}
	return ls
}

// hunk replaces base[start:end] with lines.
type hunk struct {
	start, end int
	lines      []string
}

// lineHunks diffs base against other by lines.
func lineHunks(base, other []string) []hunk {
	dmp := diffmatchpatch.New()
	a, b, table := dmp.DiffLinesToChars(strings.Join(base, ""), strings.Join(other, ""))
	diffs := dmp.DiffMain(a, b, false)
	diffs = dmp.DiffCharsToLines(diffs, table)

	var out []hunk
	pos := 0
	var cur *hunk
	flush := func() {
		if cur != nil {
			out = append(out, *cur)
			cur = nil
		}
	}
	for _, d := range diffs {
		ls := splitLines(d.Text)
		switch d.Type {
		case diffmatchpatch.DiffEqual:
			flush()
			pos += len(ls)
		case diffmatchpatch.DiffDelete:
			if cur == nil {
				cur = &hunk{start: pos, end: pos}
			}
			cur.end += len(ls)
			pos += len(ls)
		case diffmatchpatch.DiffInsert:
			if cur == nil {
				cur = &hunk{start: pos, end: pos}
			}
			cur.lines = append(cur.lines, ls...)
		}
	}
	flush()
	return out
}

// apply rewrites base[from:to] with the hunks that fall inside it.
func apply(base []string, hs []hunk, from, to int) []string {
	var out []string
	pos := from
	for _, h := range hs {
		if h.start < from || h.end > to {
			continue
		}
		out = append(out, base[pos:h.start]...)
		out = append(out, h.lines...)
		pos = h.end
	}
	return append(out, base[pos:to]...)
}

// conflictRegion is a base range changed differently by both sides.
type conflictRegion struct {
	start, end   int
	ours, theirs []string
}

// diff3 merges ours and theirs against base line by line. Changes in
// separate regions are combined; regions touched by both sides with
// different results are reported. When conflicts exist, merged takes the
// theirs version of each conflicting region.
func diff3(base, ours, theirs []string) (merged []string, conflicts []conflictRegion) {
	ha := lineHunks(base, ours)
	hb := lineHunks(base, theirs)
	var out []string
	pos := 0
	i, j := 0, 0
	for i < len(ha) || j < len(hb) {
		// Start a cluster with the earliest remaining hunk.
		var start int
		switch {
		case j >= len(hb) || (i < len(ha) && ha[i].start <= hb[j].start):
			start = ha[i].start
		default:
			start = hb[j].start
		}
		end := start
		ci, cj := i, j
		// Grow while the next hunk of either side touches the cluster.
		for {
			grew := false
			for ci < len(ha) && ha[ci].start <= end {
				if ha[ci].end > end {
					end = ha[ci].end
				}
				ci++
				grew = true
			}
			for cj < len(hb) && hb[cj].start <= end {
				if hb[cj].end > end {
					end = hb[cj].end
				}
				cj++
				grew = true
			}
			if !grew {
				break
			}
		}
		out = append(out, base[pos:start]...)
		oursText := apply(base, ha[i:ci], start, end)
		theirsText := apply(base, hb[j:cj], start, end)
		switch {
		case ci == i: // only theirs changed here
			out = append(out, theirsText...)
		case cj == j: // only ours changed here
			out = append(out, oursText...)
		case strings.Join(oursText, "") == strings.Join(theirsText, ""):
			out = append(out, oursText...)
		default:
			conflicts = append(conflicts, conflictRegion{start: start, end: end, ours: oursText, theirs: theirsText})
			out = append(out, theirsText...)
		}
		pos = end
		i, j = ci, cj
	}
	out = append(out, base[pos:]...)
	return out, conflicts
}
