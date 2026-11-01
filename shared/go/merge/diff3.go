package merge

import (
	"math"
	"strings"
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

// lineIDs interns lines so that equal lines (across all the versions being
// merged) share an id.
type lineIDs map[string]int32

func (t lineIDs) of(lines []string) ([]int32, error) {
	out := make([]int32, len(lines))
	for i, l := range lines {
		id, ok := t[l]
		if !ok {
			if len(t) == math.MaxInt32 {
				return nil, errTooLarge
			}
			id = int32(len(t)) //nolint:gosec // bounded by the check above
			t[l] = id
		}
		out[i] = id
	}
	return out, nil
}

// lineHunks diffs base against other by lines (deterministic, bounded by
// diffBudget).
func lineHunks(ids lineIDs, base, other []string) ([]hunk, error) {
	a, err := ids.of(base)
	if err != nil {
		return nil, err
	}
	b, err := ids.of(other)
	if err != nil {
		return nil, err
	}
	spans, err := diffIDs(a, b)
	if err != nil {
		return nil, err
	}
	out := make([]hunk, len(spans))
	for i, s := range spans {
		out[i] = hunk{start: s.aStart, end: s.aEnd, lines: other[s.bStart:s.bEnd]}
	}
	return out, nil
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
// theirs version of each conflicting region. errTooLarge means the versions
// could not be diffed within diffBudget: treat the whole file as conflicting.
func diff3(base, ours, theirs []string) (merged []string, conflicts []conflictRegion, err error) {
	ids := lineIDs{}
	ha, err := lineHunks(ids, base, ours)
	if err != nil {
		return nil, nil, err
	}
	hb, err := lineHunks(ids, base, theirs)
	if err != nil {
		return nil, nil, err
	}
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
	return out, conflicts, nil
}
