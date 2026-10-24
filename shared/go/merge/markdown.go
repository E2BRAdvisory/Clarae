package merge

import (
	"fmt"
	"regexp"
	"strings"
)

var frontmatterRe = regexp.MustCompile(`^---[ \t]*\r?\n(?s:(.*?))\r?\n---[ \t]*(?:\r?\n|$)`)

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

// parseFrontmatter splits the YAML between the fences into top-level entries.
// Continuation lines (indented, list items, comments, blanks) stay with the
// key above; this keeps the original text, comments included.
func parseFrontmatter(fm string) (open string, entries []fmEntry, close string) {
	lines := splitLines(fm)
	if len(lines) < 2 {
		return fm, nil, ""
	}
	open = lines[0]
	last := len(lines) - 1
	close = lines[last]
	var cur *fmEntry
	for _, l := range lines[1:last] {
		if m := keyLineRe.FindStringSubmatch(l); m != nil {
			entries = append(entries, fmEntry{key: strings.Trim(m[1], `"'`)})
			cur = &entries[len(entries)-1]
		} else if cur == nil {
			// Leading comment before the first key: keep it as an anonymous entry.
			entries = append(entries, fmEntry{key: ""})
			cur = &entries[len(entries)-1]
		}
		cur.text += l
	}
	return open, entries, close
}

func trimEntry(s string) string { return strings.TrimRight(s, " \t\r\n") }

// mergeFrontmatter merges per top-level key. The same key changed differently
// on both sides takes the remote value and is reported.
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
	open, be, _ := parseFrontmatter(base)
	_, oe, _ := parseFrontmatter(ours)
	topen, te, tclose := parseFrontmatter(theirs)
	_ = open
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

// Markdown merges Markdown (and .base YAML) text with a three-way merge: the
// frontmatter per key, the body by lines. Overlapping body edits are not
// merged: the server version is kept and ours becomes a conflict copy.
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
	bf, bb := splitFrontmatter(bs)
	of, ob := splitFrontmatter(os_)
	tf, tb := splitFrontmatter(ts)

	fm, fmConflicts := mergeFrontmatter(bf, of, tf)
	body, regions := diff3(splitLines(bb), splitLines(ob), splitLines(tb))

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
	res.Merged = []byte(fm + bodyText)
	if !res.Clean {
		res.CopyOf = Ours
	}
	return res
}
