package merge

import (
	"fmt"
	"regexp"
	"strings"
)

// frontmatterRe matches a leading YAML block. The content group is lazy and
// optional (`??`) so that an empty block ("---\n---\n") closes at its own
// second fence instead of running on to a later `---` (a thematic break) in
// the body.
var frontmatterRe = regexp.MustCompile(`^---[ \t]*\r?\n(?:(?s:.*?)\r?\n)??---[ \t]*(?:\r?\n|$)`)

// splitFrontmatter separates a leading YAML block (kept with its fences and
// line terminator) from the body.
func splitFrontmatter(s string) (fm, body string) {
	s2 := strings.TrimPrefix(s, "\xef\xbb\xbf")
	m := frontmatterRe.FindString(s2)
	if m == "" {
		return "", s
	}
	bom := len(s) - len(s2)
	return s[:bom+len(m)], s[bom+len(m):]
}

// fmEntry is one top-level YAML key with every line that belongs to it.
type fmEntry struct {
	key  string
	text string
}

var keyLineRe = regexp.MustCompile(`^("[^"]+"|'[^']+'|[^\s#:\-][^:#]*|-[^\s:][^:#]*):(?:\s|$)`)

// isContinuation reports whether l can belong to the entry above it: an
// indented line, a top-level list item, a comment or a blank line.
func isContinuation(l string) bool {
	t := strings.TrimRight(l, "\r\n")
	switch {
	case strings.TrimSpace(t) == "":
		return true
	case t[0] == ' ' || t[0] == '\t' || t[0] == '#':
		return true
	case t == "-" || strings.HasPrefix(t, "- ") || strings.HasPrefix(t, "-\t"):
		return true
	}
	return false
}

// isCommentOrBlank reports whether l carries no YAML data.
func isCommentOrBlank(l string) bool {
	t := strings.TrimSpace(l)
	return t == "" || t[0] == '#'
}

// parseFrontmatter splits the YAML between the fences into top-level entries,
// in document order. Continuation lines (indented, list items, comments,
// blanks) stay with the key above; this keeps the original text, comments
// included. ok is false when the block is not a plain mapping with unique
// top-level keys (duplicate keys, stray unindented lines, a leading sequence):
// the per-key merge would then drop or misplace lines, so the caller merges
// the block by lines instead.
func parseFrontmatter(fm string) (open string, entries []fmEntry, close string, ok bool) {
	lines := splitLines(fm)
	if len(lines) < 2 {
		return fm, nil, "", fm == ""
	}
	open = lines[0]
	last := len(lines) - 1
	close = lines[last]
	ok = true
	seen := map[string]bool{}
	var cur *fmEntry
	for _, l := range lines[1:last] {
		if m := keyLineRe.FindStringSubmatch(l); m != nil {
			key := strings.Trim(m[1], `"'`)
			if seen[key] {
				ok = false
			}
			seen[key] = true
			entries = append(entries, fmEntry{key: key})
			cur = &entries[len(entries)-1]
		} else if cur == nil {
			// Leading comment before the first key: keep it as an anonymous entry.
			if !isCommentOrBlank(l) {
				ok = false
			}
			entries = append(entries, fmEntry{key: ""})
			cur = &entries[len(entries)-1]
			seen[""] = true
		} else if (cur.key == "" && !isCommentOrBlank(l)) || !isContinuation(l) {
			ok = false
		}
		cur.text += l
	}
	return open, entries, close, ok
}

func trimEntry(s string) string { return strings.TrimRight(s, " \t\r\n") }

// mergeFrontmatter merges per top-level key. The same key changed differently
// on both sides takes the remote value and is reported. A block that does not
// parse as a plain mapping on any side is merged by lines instead.
func mergeFrontmatter(base, ours, theirs string) (string, []Hunk) {
	if ours == theirs {
		return ours, nil
	}
	if base == ours {
		return theirs, nil
	}
	if base == theirs {
		return ours, nil
	}
	if ours == "" || theirs == "" {
		// One side removed or added the whole block while the other edited it.
		if ours == "" {
			return theirs, nil
		}
		return ours, nil
	}
	_, be, _, bok := parseFrontmatter(base)
	_, oe, _, ook := parseFrontmatter(ours)
	topen, te, tclose, tok := parseFrontmatter(theirs)
	if !bok || !ook || !tok {
		return mergeFrontmatterLines(base, ours, theirs)
	}
	idx := func(es []fmEntry) map[string]string {
		m := make(map[string]string, len(es))
		for _, e := range es {
			m[e.key] = e.text
		}
		return m
	}
	bm, om, tm := idx(be), idx(oe), idx(te)
	var order []string
	seen := map[string]bool{}
	add := func(es []fmEntry) {
		for _, e := range es {
			if !seen[e.key] {
				seen[e.key] = true
				order = append(order, e.key)
			}
		}
	}
	add(be)
	add(te)
	add(oe)

	var sb strings.Builder
	var conflicts []Hunk
	sb.WriteString(topen)
	for _, k := range order {
		b, bok := bm[k]
		o, ook := om[k]
		t, tok := tm[k]
		var pick string
		var have bool
		same := func(x, y string, xok, yok bool) bool { return xok == yok && trimEntry(x) == trimEntry(y) }
		switch {
		case same(o, t, ook, tok):
			pick, have = o, ook
		case same(o, b, ook, bok): // only theirs changed (or deleted)
			pick, have = t, tok
		case same(t, b, tok, bok): // only ours changed (or deleted)
			pick, have = o, ook
		case !ook: // ours deleted, theirs modified: the modification wins
			pick, have = t, true
		case !tok:
			pick, have = o, true
		default:
			conflicts = append(conflicts, Hunk{Where: "frontmatter key " + k, Ours: trimEntry(o), Theirs: trimEntry(t)})
			pick, have = t, true
		}
		if have {
			if !strings.HasSuffix(pick, "\n") {
				pick += "\n"
			}
			sb.WriteString(pick)
		}
	}
	if tclose == "" {
		tclose = "---\n"
	}
	sb.WriteString(tclose)
	return sb.String(), conflicts
}

// mergeFrontmatterLines merges whole frontmatter blocks (fences included) by
// lines. Overlapping edits become conflicts, so no side's lines are dropped
// silently.
func mergeFrontmatterLines(base, ours, theirs string) (string, []Hunk) {
	merged, regions, err := diff3(splitLines(base), splitLines(ours), splitLines(theirs))
	if err != nil {
		return theirs, []Hunk{{Where: "frontmatter", Ours: ours, Theirs: theirs}}
	}
	var conflicts []Hunk
	for _, r := range regions {
		conflicts = append(conflicts, Hunk{
			Where:  fmt.Sprintf("frontmatter lines %d-%d", r.start+1, max(r.end, r.start+1)),
			Ours:   strings.Join(r.ours, ""),
			Theirs: strings.Join(r.theirs, ""),
		})
	}
	return strings.Join(merged, ""), conflicts
}

// joinFrontmatter concatenates a merged frontmatter block and a body. A block
// that ended at EOF on one side (closing fence without a line terminator)
// gets one, so the fence is not glued to the first body line.
func joinFrontmatter(fm, body string) string {
	if fm != "" && body != "" && !strings.HasSuffix(fm, "\n") {
		if strings.Contains(fm, "\r\n") {
			fm += "\r\n"
		} else {
			fm += "\n"
		}
	}
	return fm + body
}

// Markdown merges Markdown (and .base YAML) text with a three-way merge: the
// frontmatter per key, the body by lines. Overlapping body edits are not
// merged: the server version is kept and ours becomes a conflict copy.
//
// A side that switched the whole file to another line-ending convention
// (LF <-> CRLF) does not conflict with every line of the other side: see
// eolTarget.
func Markdown(base, ours, theirs []byte) Result {
	bs, os_, ts := string(base), string(ours), string(theirs)
	if os_ == ts {
		return Result{Merged: ours, Clean: true}
	}
	if bs == os_ {
		return Result{Merged: theirs, Clean: true}
	}
	if bs == ts {
		return Result{Merged: ours, Clean: true}
	}
	eol := eolTarget(bs, os_, ts)
	if eol == "" {
		return markdown3(bs, os_, ts)
	}
	res := markdown3(toLF(bs), toLF(os_), toLF(ts))
	if eol == "\r\n" {
		res.Merged = []byte(strings.ReplaceAll(string(res.Merged), "\n", "\r\n"))
	}
	return res
}

// markdown3 is Markdown on texts with a consistent line-ending treatment.
func markdown3(bs, os_, ts string) Result {
	if os_ == ts {
		return Result{Merged: []byte(os_), Clean: true}
	}
	if bs == os_ {
		return Result{Merged: []byte(ts), Clean: true}
	}
	if bs == ts {
		return Result{Merged: []byte(os_), Clean: true}
	}
	bf, bb := splitFrontmatter(bs)
	of, ob := splitFrontmatter(os_)
	tf, tb := splitFrontmatter(ts)

	fm, fmConflicts := mergeFrontmatter(bf, of, tf)
	body, regions, err := diff3(splitLines(bb), splitLines(ob), splitLines(tb))
	if err != nil {
		// Too different to diff within the budget: keep the server version,
		// ours goes to the conflict copy.
		return Result{
			Merged:    []byte(ts),
			Conflicts: []Hunk{{Where: "whole file (too different to merge)"}},
			CopyOf:    Ours,
		}
	}

	res := Result{Clean: true}
	bodyText := strings.Join(body, "")
	if len(regions) > 0 {
		res.Clean = false
		bodyText = tb // the server keeps the path; our edits live in the copy
		for _, r := range regions {
			res.Conflicts = append(res.Conflicts, Hunk{
				Where:  fmt.Sprintf("lines %d-%d", r.start+1, max(r.end, r.start+1)),
				Ours:   strings.Join(r.ours, ""),
				Theirs: strings.Join(r.theirs, ""),
			})
		}
	}
	if len(fmConflicts) > 0 {
		res.Clean = false
		res.Conflicts = append(fmConflicts, res.Conflicts...)
	}
	res.Merged = []byte(joinFrontmatter(fm, bodyText))
	if !res.Clean {
		res.CopyOf = Ours
	}
	return res
}

// Line-ending conventions of a text.
const (
	eolNone  = iota // no terminated line
	eolLF           // every line ends with "\n"
	eolCRLF         // every line ends with "\r\n"
	eolMixed        // both
)

func eolKind(s string) int {
	crlf := strings.Count(s, "\r\n")
	lf := strings.Count(s, "\n") - crlf
	switch {
	case crlf == 0 && lf == 0:
		return eolNone
	case crlf == 0:
		return eolLF
	case lf == 0:
		return eolCRLF
	}
	return eolMixed
}

// eolTarget decides how a merge treats line endings. It returns "" when no
// side switched convention: lines are then compared and kept byte for byte.
// When a side converted the file to a uniform convention different from
// base's (LF <-> CRLF, typically an editor or git autocrlf), lines are
// compared with CRLF folded to LF and the result is written with the
// convention of that side: theirs' when theirs switched (the server version
// is authoritative), else ours'. The rule depends only on the three inputs,
// so every device produces the same bytes. No line is dropped: only the
// terminators of every line are rewritten.
func eolTarget(base, ours, theirs string) string {
	bk := eolKind(base)
	switched := func(k int) bool { return (k == eolLF || k == eolCRLF) && k != bk && bk != eolNone }
	pick := func(k int) string {
		if k == eolCRLF {
			return "\r\n"
		}
		return "\n"
	}
	if tk := eolKind(theirs); switched(tk) {
		return pick(tk)
	}
	if ok := eolKind(ours); switched(ok) {
		return pick(ok)
	}
	return ""
}

func toLF(s string) string { return strings.ReplaceAll(s, "\r\n", "\n") }
