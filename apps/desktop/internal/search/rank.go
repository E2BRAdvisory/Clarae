package search

import (
	"context"
	"math"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"
)

// Relevance (§2.4): Okapi BM25 over the text terms of the query, computed in Go
// so the cached and the streaming evaluation rank alike. Document frequencies
// come from the FTS index (terms of 3+ characters, the trigram minimum) or,
// for shorter terms, from the matching files; document lengths are word counts.
// A term in the note title adds its weight again: a note named after the query
// ranks above one that only mentions it. Queries without text terms (tag:,
// path:, regex, …) keep the number of matches as their score.
const (
	bm25K1      = 1.2
	bm25B       = 0.75
	titleWeight = 1.0
)

// queryTerm is a term the user searched for, as matched (folded unless case sensitive).
type queryTerm struct {
	text          string
	caseSensitive bool
}

// textTerms are the positive terms of text and content predicates: the ones
// BM25 weighs. Terms under a negation never count.
func textTerms(n Node) []queryTerm {
	var out []queryTerm
	seen := map[queryTerm]bool{}
	var walk func(Node)
	walk = func(n Node) {
		switch v := n.(type) {
		case And:
			for _, it := range v.Items {
				walk(it)
			}
		case Or:
			for _, it := range v.Items {
				walk(it)
			}
		case Pred:
			if v.Op != "text" && v.Op != "content" {
				return
			}
			for _, t := range v.Terms {
				q := queryTerm{text: t, caseSensitive: v.CaseSensitive}
				if !seen[q] {
					seen[q] = true
					out = append(out, q)
				}
			}
		}
	}
	walk(n)
	return out
}

// rank sets the score of every hit.
func (e *Engine) rank(ctx context.Context, n Node, hits []found) error {
	terms := textTerms(n)
	if len(terms) == 0 || len(hits) == 0 {
		for i := range hits {
			hits[i].hit.Score = float64(hits[i].hit.Matches)
		}
		return nil
	}
	var total int
	var avgWords float64
	if err := e.db.QueryRowContext(ctx, `SELECT count(*), COALESCE(avg(NULLIF(word_count, 0)), 1) FROM files`).Scan(&total, &avgWords); err != nil {
		return err
	}
	if avgWords <= 0 {
		avgWords = 1
	}
	idf := make([]float64, len(terms))
	for i, t := range terms {
		df, err := e.docFreq(ctx, t, hits)
		if err != nil {
			return err
		}
		n := float64(max(total, df))
		idf[i] = math.Log(1 + (n-float64(df)+0.5)/(float64(df)+0.5))
	}
	for i := range hits {
		h := &hits[i]
		norm := bm25K1 * (1 - bm25B + bm25B*float64(max(h.words, 1))/avgWords)
		score := 0.0
		for j, t := range terms {
			if tf := float64(h.tf[t.text]); tf > 0 {
				score += idf[j] * tf * (bm25K1 + 1) / (tf + norm)
			}
			if h.inTitle[t.text] {
				score += idf[j] * titleWeight
			}
		}
		// Rounded so the order never depends on the summation order of the platform.
		h.hit.Score = math.Round(score*1e6) / 1e6
	}
	return nil
}

// docFreq is the number of files containing t. The FTS index answers for terms
// it can match (3+ characters, case-insensitive); otherwise the matching files
// are the only measure at hand.
func (e *Engine) docFreq(ctx context.Context, t queryTerm, hits []found) (int, error) {
	if !t.caseSensitive && utf8.RuneCountInString(t.text) >= 3 {
		var n int
		err := e.db.QueryRowContext(ctx, `SELECT count(*) FROM fts_content WHERE fts_content MATCH ?`,
			`"`+strings.ReplaceAll(t.text, `"`, `""`)+`"`).Scan(&n)
		return n, err
	}
	n := 0
	for _, h := range hits {
		if h.tf[t.text] > 0 || h.inTitle[t.text] {
			n++
		}
	}
	return n, nil
}

// countWords counts whitespace-separated words without allocating.
func countWords(s string) int {
	n, in := 0, false
	for _, r := range s {
		if unicode.IsSpace(r) {
			in = false
		} else if !in {
			in, n = true, n+1
		}
	}
	return n
}

// highlighters are the patterns marked in snippets: the positive terms of
// every predicate that matches text, and the regular expressions.
func highlighters(n Node) []*regexp.Regexp {
	var out []*regexp.Regexp
	var walk func(Node)
	walk = func(n Node) {
		switch v := n.(type) {
		case And:
			for _, it := range v.Items {
				walk(it)
			}
		case Or:
			for _, it := range v.Items {
				walk(it)
			}
		case Pred:
			switch v.Op {
			case "regex":
				out = append(out, v.Re)
			case "text", "content", "line", "block", "section", "task", "task-todo", "task-done":
				for _, t := range v.Terms {
					flags := "(?i)"
					if v.CaseSensitive {
						flags = ""
					}
					out = append(out, regexp.MustCompile(flags+regexp.QuoteMeta(t)))
				}
			}
		}
	}
	walk(n)
	return out
}

// highlight returns the ranges of s matched by the patterns, merged and in
// UTF-16 code units: the unit of JavaScript string offsets.
func highlight(s string, pats []*regexp.Regexp) [][2]int {
	var byteRanges [][2]int
	for _, re := range pats {
		for _, m := range re.FindAllStringIndex(s, -1) {
			if m[1] > m[0] {
				byteRanges = append(byteRanges, [2]int{m[0], m[1]})
			}
		}
	}
	if len(byteRanges) == 0 {
		return nil
	}
	sort.Slice(byteRanges, func(i, j int) bool { return byteRanges[i][0] < byteRanges[j][0] })
	merged := [][2]int{byteRanges[0]}
	for _, r := range byteRanges[1:] {
		last := &merged[len(merged)-1]
		if r[0] <= last[1] {
			last[1] = max(last[1], r[1])
		} else {
			merged = append(merged, r)
		}
	}
	out := make([][2]int, len(merged))
	for i, r := range merged {
		out[i] = [2]int{utf16Len(s[:r[0]]), utf16Len(s[:r[1]])}
	}
	return out
}

func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		n += len(utf16.Encode([]rune{r}))
	}
	return n
}

const snippetRunes = 160

// snippetAround trims a matching line to at most snippetRunes runes, keeping
// the match at byte offset focus in view: a long line whose match lies past
// the first 160 characters used to show none of it.
func snippetAround(line string, focus int) string {
	focus = max(0, min(focus, len(line)))
	lead := len(line) - len(strings.TrimLeftFunc(line, unicode.IsSpace))
	line = strings.TrimSpace(line)
	focus = max(0, focus-lead)
	runes := []rune(line)
	if len(runes) <= snippetRunes {
		return line
	}
	at := utf8.RuneCountInString(line[:min(focus, len(line))])
	start := max(0, min(at-snippetRunes/4, len(runes)-snippetRunes))
	out := string(runes[start : start+snippetRunes])
	if start > 0 {
		out = "…" + out
	}
	if start+snippetRunes < len(runes) {
		out += "…"
	}
	return out
}
