package merge

import "errors"

// errTooLarge reports that two versions differ too much to be diffed within
// diffBudget. The caller treats it as a conflict: the server version is kept
// and ours becomes a conflict copy, so nothing is lost (D-04).
var errTooLarge = errors.New("merge: versions differ too much to merge automatically")

// diffBudget bounds the work of one line diff, counted in Myers steps
// (diagonals visited plus matching lines followed); the cost of Myers is
// O((N+M)·D) for N+M lines and D edits. Measured with BenchmarkLineDiff and
// TestDiffWork on an Apple M4 (about 2.3e8 steps/s): a 60,000-line file with
// 600 scattered line edits costs 2.5e6 steps (9 ms), with 3,000 edits 2e7
// (90 ms); two completely different 6,000-line texts cost 3.6e7 (160 ms).
// The budget therefore admits any realistic note (and rewrites up to about
// 10,000 lines) while capping the worst case near half a second per diff
// on a fast laptop. The decision depends only on the inputs, never on the
// clock, so the same three versions merge (or conflict) identically on
// every device; beyond it the merge is a conflict copy.
const diffBudget = 100_000_000

// lineDiffer computes a minimal line diff with Myers' linear-space
// algorithm ("An O(ND) Difference Algorithm and Its Variations", 1986).
// Lines are compared through interned ids, so there is no limit on the
// number of distinct lines (go-diff packs lines into runes and overflows
// past ~1.1M distinct lines).
type lineDiffer struct {
	a, b  []int32
	work  int
	hunks []span
}

// span replaces a[aStart:aEnd] with b[bStart:bEnd].
type span struct {
	aStart, aEnd, bStart, bEnd int
}

// diffIDs returns the edits that turn a into b, in order, or errTooLarge.
func diffIDs(a, b []int32) ([]span, error) {
	d := &lineDiffer{a: a, b: b}
	if err := d.diff(0, len(a), 0, len(b)); err != nil {
		return nil, err
	}
	return d.hunks, nil
}

func (d *lineDiffer) emit(s span) {
	if s.aStart == s.aEnd && s.bStart == s.bEnd {
		return
	}
	if n := len(d.hunks); n > 0 {
		last := &d.hunks[n-1]
		if last.aEnd == s.aStart && last.bEnd == s.bStart {
			last.aEnd, last.bEnd = s.aEnd, s.bEnd
			return
		}
	}
	d.hunks = append(d.hunks, s)
}

func (d *lineDiffer) diff(a0, a1, b0, b1 int) error {
	// Trim the common prefix and suffix.
	for a0 < a1 && b0 < b1 && d.a[a0] == d.b[b0] {
		a0++
		b0++
	}
	for a0 < a1 && b0 < b1 && d.a[a1-1] == d.b[b1-1] {
		a1--
		b1--
	}
	d.work += a1 - a0 + b1 - b0
	if d.work > diffBudget {
		return errTooLarge
	}
	if a0 == a1 || b0 == b1 {
		d.emit(span{a0, a1, b0, b1})
		return nil
	}
	x, y, ok, err := d.middle(a0, a1, b0, b1)
	if err != nil {
		return err
	}
	if !ok || (x == 0 && y == 0) || (a0+x == a1 && b0+y == b1) {
		// No common line at all (or a split that would not shrink the
		// problem): replace the whole range. Coarser, never wrong.
		d.emit(span{a0, a1, b0, b1})
		return nil
	}
	if err := d.diff(a0, a0+x, b0, b0+y); err != nil {
		return err
	}
	return d.diff(a0+x, a1, b0+y, b1)
}

// middle finds a point (x, y), relative to (a0, b0), on an optimal edit
// path where the forward and reverse searches overlap. The ranges are
// non-empty and share no prefix or suffix. ok is false when the searches
// never overlap (the ranges have nothing in common).
func (d *lineDiffer) middle(a0, a1, b0, b1 int) (x, y int, ok bool, err error) {
	a, b := d.a[a0:a1], d.b[b0:b1]
	n, m := len(a), len(b)
	maxD := (n + m + 1) / 2
	off := maxD + 1
	vlen := 2*maxD + 3
	v1 := make([]int, vlen)
	v2 := make([]int, vlen)
	for i := range v1 {
		v1[i] = -1
		v2[i] = -1
	}
	v1[off+1] = 0
	v2[off+1] = 0
	delta := n - m
	// With an odd delta the forward path meets the reverse one.
	front := delta%2 != 0
	k1start, k1end, k2start, k2end := 0, 0, 0, 0
	for step := 0; step < maxD; step++ {
		if d.work > diffBudget {
			return 0, 0, false, errTooLarge
		}
		for k1 := -step + k1start; k1 <= step-k1end; k1 += 2 {
			k1off := off + k1
			var x1 int
			if k1 == -step || (k1 != step && v1[k1off-1] < v1[k1off+1]) {
				x1 = v1[k1off+1]
			} else {
				x1 = v1[k1off-1] + 1
			}
			y1 := x1 - k1
			for x1 < n && y1 < m && a[x1] == b[y1] {
				x1++
				y1++
				d.work++
			}
			d.work++
			v1[k1off] = x1
			switch {
			case x1 > n: // ran off the right of the graph
				k1end += 2
			case y1 > m: // ran off the bottom of the graph
				k1start += 2
			case front:
				k2off := off + delta - k1
				if k2off >= 0 && k2off < vlen && v2[k2off] != -1 && x1 >= n-v2[k2off] {
					return x1, y1, true, nil
				}
			}
		}
		for k2 := -step + k2start; k2 <= step-k2end; k2 += 2 {
			k2off := off + k2
			var x2 int
			if k2 == -step || (k2 != step && v2[k2off-1] < v2[k2off+1]) {
				x2 = v2[k2off+1]
			} else {
				x2 = v2[k2off-1] + 1
			}
			y2 := x2 - k2
			for x2 < n && y2 < m && a[n-x2-1] == b[m-y2-1] {
				x2++
				y2++
				d.work++
			}
			d.work++
			v2[k2off] = x2
			switch {
			case x2 > n: // ran off the left of the graph
				k2end += 2
			case y2 > m: // ran off the top of the graph
				k2start += 2
			case !front:
				k1off := off + delta - k2
				if k1off >= 0 && k1off < vlen && v1[k1off] != -1 {
					x1 := v1[k1off]
					if x1 >= n-x2 {
						return x1, off + x1 - k1off, true, nil
					}
				}
			}
		}
	}
	return 0, 0, false, nil
}
