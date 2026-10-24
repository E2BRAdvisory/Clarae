// Package search implements the vault query language of §2.4: terms and
// phrases, OR / - / parentheses, scoped operators (file:, path:, content:,
// tag:, line:, block:, section:, task:, task-todo:, task-done:), property
// filters [prop:value], regular expressions and case switches. A query is
// parsed to an AST and evaluated against the local index; contents are read
// from the index (fts_content), never from disk.
package search

import (
	"fmt"
	"regexp"
	"strings"
	"unicode"
)

// Node is a query AST node.
type Node interface{ String() string }

// And is an implicit conjunction.
type And struct{ Items []Node }

// Or is an explicit disjunction (OR).
type Or struct{ Items []Node }

// Not negates its operand (leading '-').
type Not struct{ Item Node }

// Pred is a leaf predicate.
type Pred struct {
	// Op is one of: text, file, path, content, tag, line, block, section,
	// task, task-todo, task-done, prop, regex.
	Op string
	// Terms are the (lower-cased unless CaseSensitive) words that must all match;
	// a phrase is a single term containing spaces.
	Terms         []string
	CaseSensitive bool
	// Prop/Cmp/Value describe [prop:value] filters; Cmp is one of "", "=", "<", ">", "<=", ">=".
	Prop, Cmp, Value string
	Re               *regexp.Regexp
}

func (a And) String() string { return joinNodes("AND", a.Items) }
func (o Or) String() string  { return joinNodes("OR", o.Items) }
func (n Not) String() string { return "NOT " + n.Item.String() }
func (p Pred) String() string {
	switch p.Op {
	case "regex":
		return "regex /" + p.Re.String() + "/"
	case "prop":
		return fmt.Sprintf("property %s%s%s", p.Prop, p.Cmp, p.Value)
	default:
		return fmt.Sprintf("%s %q", p.Op, strings.Join(p.Terms, " "))
	}
}

func joinNodes(op string, items []Node) string {
	parts := make([]string, len(items))
	for i, it := range items {
		parts[i] = it.String()
	}
	return "(" + strings.Join(parts, " "+op+" ") + ")"
}

// ParseError reports a malformed query with the offset of the problem.
type ParseError struct {
	Msg    string
	Offset int
}

func (e *ParseError) Error() string { return fmt.Sprintf("query: %s (at %d)", e.Msg, e.Offset) }

type queryParser struct {
	src []rune
	pos int
	// case switches apply to the next term only (match-case: / ignore-case:)
	forceCase *bool
}

// Parse turns a query string into an AST. An empty query yields And{}.
func Parse(q string) (Node, error) {
	p := &queryParser{src: []rune(q)}
	n, err := p.parseOr()
	if err != nil {
		return nil, err
	}
	p.skipSpace()
	if p.pos < len(p.src) {
		return nil, &ParseError{"unexpected " + string(p.src[p.pos]), p.pos}
	}
	return n, nil
}

func (p *queryParser) skipSpace() {
	for p.pos < len(p.src) && unicode.IsSpace(p.src[p.pos]) {
		p.pos++
	}
}

func (p *queryParser) peekWord(w string) bool {
	p.skipSpace()
	end := p.pos + len(w)
	if end > len(p.src) || string(p.src[p.pos:end]) != w {
		return false
	}
	return end == len(p.src) || unicode.IsSpace(p.src[end]) || p.src[end] == '(' || p.src[end] == ')'
}

func (p *queryParser) parseOr() (Node, error) {
	first, err := p.parseAnd()
	if err != nil {
		return nil, err
	}
	items := []Node{first}
	for p.peekWord("OR") {
		p.pos += 2
		next, err := p.parseAnd()
		if err != nil {
			return nil, err
		}
		items = append(items, next)
	}
	if len(items) == 1 {
		return first, nil
	}
	return Or{items}, nil
}

func (p *queryParser) parseAnd() (Node, error) {
	var items []Node
	for {
		p.skipSpace()
		if p.pos >= len(p.src) || p.src[p.pos] == ')' || p.peekWord("OR") {
			break
		}
		n, err := p.parseUnary()
		if err != nil {
			return nil, err
		}
		items = append(items, n)
	}
	if len(items) == 1 {
		return items[0], nil
	}
	return And{items}, nil
}

func (p *queryParser) parseUnary() (Node, error) {
	p.skipSpace()
	if p.src[p.pos] == '-' && p.pos+1 < len(p.src) && !unicode.IsSpace(p.src[p.pos+1]) {
		p.pos++
		n, err := p.parseUnary()
		if err != nil {
			return nil, err
		}
		return Not{n}, nil
	}
	return p.parseAtom()
}

var scopedOps = map[string]bool{
	"file": true, "path": true, "content": true, "tag": true, "line": true, "block": true,
	"section": true, "task": true, "task-todo": true, "task-done": true,
}

func (p *queryParser) parseAtom() (Node, error) {
	p.skipSpace()
	start := p.pos
	switch c := p.src[p.pos]; c {
	case '(':
		p.pos++
		n, err := p.parseOr()
		if err != nil {
			return nil, err
		}
		p.skipSpace()
		if p.pos >= len(p.src) || p.src[p.pos] != ')' {
			return nil, &ParseError{"missing )", start}
		}
		p.pos++
		return n, nil
	case '[':
		return p.parseProperty()
	case '"':
		s, err := p.parseQuoted()
		if err != nil {
			return nil, err
		}
		return p.text("text", []string{s}), nil
	case '/':
		if re, ok, err := p.tryRegex(); err != nil {
			return nil, err
		} else if ok {
			return Pred{Op: "regex", Re: re}, nil
		}
	}
	word := p.readWord()
	if word == "" {
		return nil, &ParseError{"unexpected " + string(p.src[p.pos]), p.pos}
	}
	// operator:value
	if i := strings.IndexByte(word, ':'); i > 0 {
		op := strings.ToLower(word[:i])
		switch {
		case op == "match-case" || op == "ignore-case":
			b := op == "match-case"
			p.forceCase = &b
			rest := word[i+1:]
			if rest == "" {
				return p.parseAtom()
			}
			p.pos -= len([]rune(rest))
			return p.parseAtom()
		case scopedOps[op]:
			p.pos -= len([]rune(word[i+1:]))
			return p.parseOperatorValue(op)
		}
	}
	return p.text("text", []string{word}), nil
}

func (p *queryParser) parseOperatorValue(op string) (Node, error) {
	if p.pos >= len(p.src) || unicode.IsSpace(p.src[p.pos]) {
		return nil, &ParseError{op + ": needs a value", p.pos}
	}
	var terms []string
	switch p.src[p.pos] {
	case '(':
		p.pos++
		for {
			p.skipSpace()
			if p.pos >= len(p.src) {
				return nil, &ParseError{"missing )", p.pos}
			}
			if p.src[p.pos] == ')' {
				p.pos++
				break
			}
			if p.src[p.pos] == '"' {
				s, err := p.parseQuoted()
				if err != nil {
					return nil, err
				}
				terms = append(terms, s)
				continue
			}
			w := p.readWord()
			if w == "" {
				return nil, &ParseError{"unexpected " + string(p.src[p.pos]), p.pos}
			}
			terms = append(terms, w)
		}
	case '"':
		s, err := p.parseQuoted()
		if err != nil {
			return nil, err
		}
		terms = []string{s}
	default:
		terms = []string{p.readWord()}
	}
	if op == "tag" {
		for i := range terms {
			terms[i] = strings.TrimPrefix(terms[i], "#")
		}
	}
	return p.text(op, terms), nil
}

// text builds a term predicate honoring a pending match-case:/ignore-case:.
func (p *queryParser) text(op string, terms []string) Pred {
	cs := false
	if p.forceCase != nil {
		cs = *p.forceCase
		p.forceCase = nil
	}
	out := make([]string, 0, len(terms))
	for _, t := range terms {
		if !cs {
			t = strings.ToLower(t)
		}
		out = append(out, t)
	}
	return Pred{Op: op, Terms: out, CaseSensitive: cs}
}

func (p *queryParser) readWord() string {
	start := p.pos
	for p.pos < len(p.src) && !unicode.IsSpace(p.src[p.pos]) && p.src[p.pos] != ')' && p.src[p.pos] != '(' {
		p.pos++
	}
	return string(p.src[start:p.pos])
}

func (p *queryParser) parseQuoted() (string, error) {
	start := p.pos
	p.pos++ // opening quote
	var b strings.Builder
	for p.pos < len(p.src) {
		c := p.src[p.pos]
		if c == '\\' && p.pos+1 < len(p.src) {
			p.pos++
			b.WriteRune(p.src[p.pos])
			p.pos++
			continue
		}
		if c == '"' {
			p.pos++
			return b.String(), nil
		}
		b.WriteRune(c)
		p.pos++
	}
	return "", &ParseError{"unterminated quote", start}
}

// tryRegex parses /.../ when the slash opens a regular expression (a closing
// unescaped slash exists before whitespace-free end); otherwise it reports
// ok=false and the slash is treated as part of a plain word.
func (p *queryParser) tryRegex() (*regexp.Regexp, bool, error) {
	i := p.pos + 1
	for i < len(p.src) {
		if p.src[i] == '\\' {
			i += 2
			continue
		}
		if p.src[i] == '/' {
			break
		}
		i++
	}
	if i >= len(p.src) || i == p.pos+1 {
		return nil, false, nil
	}
	expr := string(p.src[p.pos+1 : i])
	flags := "(?i)"
	if p.forceCase != nil && *p.forceCase {
		flags = ""
	}
	p.forceCase = nil
	re, err := regexp.Compile(flags + expr)
	if err != nil {
		return nil, false, &ParseError{"invalid regular expression: " + err.Error(), p.pos}
	}
	p.pos = i + 1
	return re, true, nil
}

func (p *queryParser) parseProperty() (Node, error) {
	start := p.pos
	end := -1
	for i := p.pos + 1; i < len(p.src); i++ {
		if p.src[i] == ']' {
			end = i
			break
		}
	}
	if end < 0 {
		return nil, &ParseError{"missing ]", start}
	}
	inner := strings.TrimSpace(string(p.src[p.pos+1 : end]))
	p.pos = end + 1
	name, rest, hasValue := strings.Cut(inner, ":")
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, &ParseError{"property name is empty", start}
	}
	pred := Pred{Op: "prop", Prop: strings.ToLower(name), Cmp: ""}
	if !hasValue {
		return pred, nil
	}
	rest = strings.TrimSpace(rest)
	pred.Cmp = "="
	for _, c := range []string{"<=", ">=", "<", ">"} {
		if strings.HasPrefix(rest, c) {
			pred.Cmp, rest = c, strings.TrimSpace(rest[len(c):])
			break
		}
	}
	pred.Value = strings.Trim(rest, `"`)
	return pred, nil
}
