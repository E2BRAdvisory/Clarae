package bases

import (
	"fmt"
	"strconv"
	"strings"
	"unicode"
)

// Expr is a node of the parsed expression tree.
type Expr interface{}

type (
	numLit  float64
	strLit  string
	boolLit bool
	nullLit struct{}
	listLit []Expr
	ident   string
	member  struct {
		obj  Expr
		name string
	}
	indexExpr struct{ obj, idx Expr }
	callExpr  struct {
		fn   Expr // ident (global function) or member (method)
		args []Expr
	}
	unaryExpr struct {
		op string
		x  Expr
	}
	binaryExpr struct {
		op   string
		l, r Expr
	}
)

type tokKind int

const (
	tEOF tokKind = iota
	tNum
	tStr
	tIdent
	tOp
)

type token struct {
	kind tokKind
	s    string
	n    float64
	pos  int
}

func lex(src string) ([]token, error) {
	var toks []token
	rs := []rune(src)
	for i := 0; i < len(rs); {
		c := rs[i]
		switch {
		case unicode.IsSpace(c):
			i++
		case unicode.IsDigit(c) || (c == '.' && i+1 < len(rs) && unicode.IsDigit(rs[i+1])):
			j := i
			for j < len(rs) && (unicode.IsDigit(rs[j]) || rs[j] == '.') {
				j++
			}
			n, err := strconv.ParseFloat(string(rs[i:j]), 64)
			if err != nil {
				return nil, fmt.Errorf("invalid number %q", string(rs[i:j]))
			}
			toks = append(toks, token{kind: tNum, n: n, pos: i})
			i = j
		case c == '"' || c == '\'':
			var b strings.Builder
			j := i + 1
			closed := false
			for j < len(rs) {
				if rs[j] == '\\' && j+1 < len(rs) {
					switch rs[j+1] {
					case 'n':
						b.WriteRune('\n')
					case 't':
						b.WriteRune('\t')
					default:
						b.WriteRune(rs[j+1])
					}
					j += 2
					continue
				}
				if rs[j] == c {
					closed = true
					j++
					break
				}
				b.WriteRune(rs[j])
				j++
			}
			if !closed {
				return nil, fmt.Errorf("unterminated string at position %d", i)
			}
			toks = append(toks, token{kind: tStr, s: b.String(), pos: i})
			i = j
		case unicode.IsLetter(c) || c == '_':
			j := i
			for j < len(rs) && (unicode.IsLetter(rs[j]) || unicode.IsDigit(rs[j]) || rs[j] == '_') {
				j++
			}
			toks = append(toks, token{kind: tIdent, s: string(rs[i:j]), pos: i})
			i = j
		default:
			two := ""
			if i+1 < len(rs) {
				two = string(rs[i : i+2])
			}
			switch two {
			case "==", "!=", ">=", "<=", "&&", "||":
				toks = append(toks, token{kind: tOp, s: two, pos: i})
				i += 2
				continue
			}
			if strings.ContainsRune("+-*/%<>!()[],.", c) {
				toks = append(toks, token{kind: tOp, s: string(c), pos: i})
				i++
				continue
			}
			return nil, fmt.Errorf("unexpected character %q at position %d", c, i)
		}
	}
	toks = append(toks, token{kind: tEOF, pos: len(rs)})
	return toks, nil
}

type parser struct {
	toks []token
	pos  int
}

// ParseExpr parses the expression language: literals, property references,
// member access, calls, index, unary/binary operators.
func ParseExpr(src string) (Expr, error) {
	if strings.TrimSpace(src) == "" {
		return nil, fmt.Errorf("empty expression")
	}
	toks, err := lex(src)
	if err != nil {
		return nil, err
	}
	p := &parser{toks: toks}
	e, err := p.or()
	if err != nil {
		return nil, err
	}
	if t := p.peek(); t.kind != tEOF {
		return nil, fmt.Errorf("unexpected %s at position %d", describe(t), t.pos)
	}
	return e, nil
}

func describe(t token) string {
	switch t.kind {
	case tEOF:
		return "end of expression"
	case tNum:
		return "number"
	case tStr:
		return "string"
	}
	return fmt.Sprintf("%q", t.s)
}

func (p *parser) peek() token { return p.toks[p.pos] }
func (p *parser) next() token {
	t := p.toks[p.pos]
	if t.kind != tEOF {
		p.pos++
	}
	return t
}
func (p *parser) isOp(s string) bool {
	t := p.peek()
	return t.kind == tOp && t.s == s
}
func (p *parser) expectOp(s string) error {
	if !p.isOp(s) {
		return fmt.Errorf("expected %q but found %s at position %d", s, describe(p.peek()), p.peek().pos)
	}
	p.pos++
	return nil
}

func (p *parser) binary(sub func() (Expr, error), ops ...string) (Expr, error) {
	l, err := sub()
	if err != nil {
		return nil, err
	}
	for {
		t := p.peek()
		matched := false
		if t.kind == tOp {
			for _, op := range ops {
				if t.s == op {
					matched = true
				}
			}
		}
		if !matched {
			return l, nil
		}
		p.pos++
		r, err := sub()
		if err != nil {
			return nil, err
		}
		l = &binaryExpr{op: t.s, l: l, r: r}
	}
}

func (p *parser) or() (Expr, error)  { return p.binary(p.and, "||") }
func (p *parser) and() (Expr, error) { return p.binary(p.eq, "&&") }
func (p *parser) eq() (Expr, error)  { return p.binary(p.cmp, "==", "!=") }
func (p *parser) cmp() (Expr, error) { return p.binary(p.add, "<", ">", "<=", ">=") }
func (p *parser) add() (Expr, error) { return p.binary(p.mul, "+", "-") }
func (p *parser) mul() (Expr, error) { return p.binary(p.unary, "*", "/", "%") }

func (p *parser) unary() (Expr, error) {
	if p.isOp("!") || p.isOp("-") {
		op := p.next().s
		x, err := p.unary()
		if err != nil {
			return nil, err
		}
		return &unaryExpr{op: op, x: x}, nil
	}
	return p.postfix()
}

func (p *parser) postfix() (Expr, error) {
	e, err := p.primary()
	if err != nil {
		return nil, err
	}
	for {
		switch {
		case p.isOp("."):
			p.pos++
			t := p.next()
			if t.kind != tIdent {
				return nil, fmt.Errorf("expected a name after '.' at position %d", t.pos)
			}
			e = &member{obj: e, name: t.s}
		case p.isOp("["):
			p.pos++
			idx, err := p.or()
			if err != nil {
				return nil, err
			}
			if err := p.expectOp("]"); err != nil {
				return nil, err
			}
			e = &indexExpr{obj: e, idx: idx}
		case p.isOp("("):
			p.pos++
			args, err := p.args(")")
			if err != nil {
				return nil, err
			}
			e = &callExpr{fn: e, args: args}
		default:
			return e, nil
		}
	}
}

func (p *parser) args(closer string) ([]Expr, error) {
	var out []Expr
	if p.isOp(closer) {
		p.pos++
		return out, nil
	}
	for {
		a, err := p.or()
		if err != nil {
			return nil, err
		}
		out = append(out, a)
		if p.isOp(",") {
			p.pos++
			continue
		}
		if err := p.expectOp(closer); err != nil {
			return nil, err
		}
		return out, nil
	}
}

func (p *parser) primary() (Expr, error) {
	t := p.next()
	switch t.kind {
	case tNum:
		return numLit(t.n), nil
	case tStr:
		return strLit(t.s), nil
	case tIdent:
		switch t.s {
		case "true":
			return boolLit(true), nil
		case "false":
			return boolLit(false), nil
		case "null":
			return nullLit{}, nil
		}
		return ident(t.s), nil
	case tOp:
		switch t.s {
		case "(":
			e, err := p.or()
			if err != nil {
				return nil, err
			}
			return e, p.expectOp(")")
		case "[":
			items, err := p.args("]")
			if err != nil {
				return nil, err
			}
			return listLit(items), nil
		}
	}
	return nil, fmt.Errorf("unexpected %s at position %d", describe(t), t.pos)
}
