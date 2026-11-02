package bases

import (
	"fmt"
	"math"
	"path"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// PropEntry is one frontmatter property of a note (value already typed).
type PropEntry struct {
	Key   string
	Kind  string // indexed kind: text | list | number | checkbox | date | datetime
	Value any
}

// Note is a file with its indexed metadata: what the query engine sees.
type Note struct {
	Path   string
	Hash   string
	Size   int64
	MTime  time.Time
	CTime  time.Time
	Tags   []string // with the leading '#'
	Links  []string // targets (resolved path when known)
	Props  []PropEntry
	folder string
	name   string
	ext    string
}

// Prepare derives name, folder and extension from the path.
func (n *Note) Prepare() {
	n.name = path.Base(n.Path)
	n.folder = path.Dir(n.Path)
	if n.folder == "." {
		n.folder = ""
	}
	n.ext = strings.TrimPrefix(path.Ext(n.Path), ".")
}

func (n *Note) basename() string { return strings.TrimSuffix(n.name, path.Ext(n.name)) }

// Prop returns the value of a frontmatter property (exact key, then case-insensitive).
func (n *Note) Prop(key string) (PropEntry, bool) {
	for _, p := range n.Props {
		if p.Key == key {
			return p, true
		}
	}
	for _, p := range n.Props {
		if strings.EqualFold(p.Key, key) {
			return p, true
		}
	}
	return PropEntry{}, false
}

// evalError is raised (panic) inside the evaluator and recovered by Eval.
type evalError struct{ msg string }

func fail(format string, a ...any) {
	msg := fmt.Sprintf(format, a...)
	// The message quotes values that may be long texts: the error of a cell
	// (one per row) must not carry them.
	if len(msg) > maxErrorLen {
		cut := maxErrorLen
		for cut > 0 && !utf8.RuneStart(msg[cut]) {
			cut--
		}
		msg = msg[:cut] + "…"
	}
	panic(evalError{msg})
}

const maxErrorLen = 200

type fileObj struct{ n *Note }
type noteObj struct{ n *Note }
type formulaObj struct{}
type thisObj struct{ n *Note }

// Env is the evaluation context of one row.
type Env struct {
	Note     *Note
	This     *Note
	Now      time.Time
	Formulas map[string]*Formula

	cache   map[string]any
	running map[string]bool
	locals  map[string]any
	steps   int        // spent by the current Eval/EvalFormula
	bytes   int        // produced for this row (see charge)
	run     *runBudget // shared by the rows of a Run
}

// Formula is a named, parsed formula ("formulas" section).
type Formula struct {
	Name string
	Src  string
	Expr Expr
	Err  string // parse error
}

// NewEnv prepares an environment for one note.
func NewEnv(n, this *Note, now time.Time, formulas map[string]*Formula) *Env {
	return &Env{Note: n, This: this, Now: now, Formulas: formulas}
}

// Eval evaluates e, converting evaluator failures into an error. Any other
// panic becomes an error too (*PanicError): it must not escape to the caller.
func (env *Env) Eval(e Expr) (v any, err error) {
	defer env.recoverEval(&v, &err)
	env.steps = 0
	return env.eval(e), nil
}

// EvalFormula evaluates a named formula for the env's note (cached per row).
func (env *Env) EvalFormula(name string) (v any, err error) {
	defer env.recoverEval(&v, &err)
	env.steps = 0
	return env.formula(name), nil
}

func (env *Env) formula(name string) any {
	if v, ok := env.cache[name]; ok {
		return v
	}
	f, ok := env.Formulas[name]
	if !ok {
		fail("unknown formula %q", name)
	}
	if f.Err != "" {
		fail("formula %q: %s", name, f.Err)
	}
	if env.running[name] {
		fail("formula %q refers to itself", name)
	}
	if env.running == nil {
		env.running, env.cache = map[string]bool{}, map[string]any{}
	}
	env.running[name] = true
	defer delete(env.running, name)
	saved := env.locals
	env.locals = nil
	defer func() { env.locals = saved }()
	v := env.eval(f.Expr)
	env.cache[name] = v
	return v
}

func (env *Env) eval(e Expr) any {
	env.tick(1)
	switch t := e.(type) {
	case numLit:
		return float64(t)
	case strLit:
		return string(t)
	case boolLit:
		return bool(t)
	case nullLit:
		return nil
	case listLit:
		env.chargeList(len(t))
		out := make([]any, len(t))
		for i, x := range t {
			out[i] = env.eval(x)
		}
		return out
	case ident:
		return env.ident(string(t))
	case *member:
		return env.member(env.eval(t.obj), t.name)
	case *indexExpr:
		return env.index(env.eval(t.obj), env.eval(t.idx))
	case *unaryExpr:
		x := env.eval(t.x)
		if t.op == "!" {
			return !Truthy(x)
		}
		n, ok := x.(float64)
		if !ok {
			fail("cannot negate %s", KindOf(x))
		}
		return -n
	case *binaryExpr:
		return env.binary(t)
	case *callExpr:
		return env.call(t)
	}
	fail("unsupported expression")
	return nil
}

func (env *Env) ident(name string) any {
	switch name {
	case "file":
		return fileObj{env.Note}
	case "note":
		return noteObj{env.Note}
	case "formula":
		return formulaObj{}
	case "this":
		if env.This == nil {
			return nil
		}
		return thisObj{env.This}
	}
	if v, ok := env.locals[name]; ok {
		return v
	}
	return propValue(env.Note, name)
}

func propValue(n *Note, key string) any {
	if p, ok := n.Prop(key); ok {
		return p.Value
	}
	return nil
}

func fileField(n *Note, name string) any {
	switch name {
	case "name":
		return n.name
	case "basename":
		return n.basename()
	case "path":
		return n.Path
	case "folder":
		return n.folder
	case "ext":
		return n.ext
	case "size":
		return float64(n.Size)
	case "ctime":
		return Date{T: n.CTime, HasTime: true}
	case "mtime":
		return Date{T: n.MTime, HasTime: true}
	case "tags":
		out := make([]any, len(n.Tags))
		for i, t := range n.Tags {
			out[i] = t
		}
		return out
	case "links":
		out := make([]any, len(n.Links))
		for i, l := range n.Links {
			out[i] = Link{Target: l}
		}
		return out
	}
	fail("unknown file property %q", name)
	return nil
}

// FileProps lists the supported file.* properties.
var FileProps = []string{"name", "basename", "path", "folder", "ext", "size", "ctime", "mtime", "tags", "links"}

func (env *Env) member(obj any, name string) any {
	switch t := obj.(type) {
	case fileObj:
		switch name {
		case "tags":
			env.chargeList(len(t.n.Tags))
		case "links":
			env.chargeList(len(t.n.Links))
		}
		return fileField(t.n, name)
	case noteObj:
		return propValue(t.n, name)
	case formulaObj:
		return env.formula(name)
	case thisObj:
		return propValue(t.n, name)
	case nil:
		return nil
	case string:
		if name == "length" {
			env.scan(len(t))
			return float64(utf8.RuneCountInString(t))
		}
	case []any:
		if name == "length" {
			return float64(len(t))
		}
	case Date:
		switch name {
		case "year":
			return float64(t.T.Year())
		case "month":
			return float64(t.T.Month())
		case "day":
			return float64(t.T.Day())
		case "hour":
			return float64(t.T.Hour())
		case "minute":
			return float64(t.T.Minute())
		case "second":
			return float64(t.T.Second())
		case "millisecond":
			return float64(t.T.Nanosecond() / 1e6)
		}
	case Duration:
		switch name {
		case "milliseconds":
			return t.Ms
		case "seconds":
			return t.Ms / 1000
		case "minutes":
			return t.Ms / 60_000
		case "hours":
			return t.Ms / 3_600_000
		case "days":
			return t.Ms / 86_400_000
		case "weeks":
			return t.Ms / (7 * 86_400_000)
		}
	case Link:
		if name == "path" || name == "target" {
			return t.Target
		}
	}
	fail("cannot read %q of %s", name, KindOf(obj))
	return nil
}

func (env *Env) index(obj, idx any) any {
	switch t := obj.(type) {
	case []any:
		i, ok := idx.(float64)
		if !ok {
			fail("list index must be a number")
		}
		k := int(i)
		if k < 0 {
			k += len(t)
		}
		if k < 0 || k >= len(t) {
			return nil
		}
		return t[k]
	case noteObj:
		return propValue(t.n, env.str(idx))
	case thisObj:
		return propValue(t.n, env.str(idx))
	case fileObj:
		return env.member(t, env.str(idx))
	case formulaObj:
		return env.formula(env.str(idx))
	case nil:
		return nil
	}
	fail("cannot index %s", KindOf(obj))
	return nil
}

func (env *Env) binary(b *binaryExpr) any {
	switch b.op {
	case "&&":
		l := env.eval(b.l)
		if !Truthy(l) {
			return false
		}
		return Truthy(env.eval(b.r))
	case "||":
		if Truthy(env.eval(b.l)) {
			return true
		}
		return Truthy(env.eval(b.r))
	}
	l, r := env.eval(b.l), env.eval(b.r)
	switch b.op {
	case "==":
		return env.equal(l, r)
	case "!=":
		return !env.equal(l, r)
	case "<", ">", "<=", ">=":
		if l == nil || r == nil {
			return false
		}
		env.scanValue(l)
		env.scanValue(r)
		c, ok := Compare(l, r)
		if !ok {
			fail("cannot compare %s with %s", KindOf(l), KindOf(r))
		}
		switch b.op {
		case "<":
			return c < 0
		case ">":
			return c > 0
		case "<=":
			return c <= 0
		}
		return c >= 0
	}
	return env.arith(b.op, l, r)
}

func (env *Env) arith(op string, l, r any) any {
	// Dates and durations.
	if d, ok := l.(Date); ok {
		switch op {
		case "+", "-":
			if r2, ok := r.(Date); ok && op == "-" {
				return Duration{Ms: float64(d.T.Sub(r2.T)) / float64(time.Millisecond)}
			}
			dur, ok := toDuration(r)
			if !ok {
				fail("cannot %s %s to a date", map[string]string{"+": "add", "-": "subtract"}[op], KindOf(r))
			}
			if op == "-" {
				dur.Ms = -dur.Ms
			}
			return Date{T: d.T.Add(time.Duration(dur.Ms * float64(time.Millisecond))), HasTime: d.HasTime || math.Mod(dur.Ms, 86_400_000) != 0}
		}
	}
	if d, ok := l.(Duration); ok {
		if r2, ok := toDuration(r); ok {
			switch op {
			case "+":
				return Duration{Ms: d.Ms + r2.Ms}
			case "-":
				return Duration{Ms: d.Ms - r2.Ms}
			}
		}
		if n, ok := r.(float64); ok {
			switch op {
			case "*":
				return Duration{Ms: d.Ms * n}
			case "/":
				return Duration{Ms: d.Ms / n}
			}
		}
	}
	ln, lok := l.(float64)
	rn, rok := r.(float64)
	if lok && rok {
		switch op {
		case "+":
			return ln + rn
		case "-":
			return ln - rn
		case "*":
			return ln * rn
		case "/":
			if rn == 0 {
				fail("division by zero")
			}
			return ln / rn
		case "%":
			if rn == 0 {
				fail("division by zero")
			}
			return math.Mod(ln, rn)
		}
	}
	if op == "+" {
		if l == nil || r == nil {
			if l == nil && r == nil {
				return nil
			}
		}
		_, ls := l.(string)
		_, rs := r.(string)
		if ls || rs {
			a, b := env.str(l), env.str(r)
			env.charge(len(a) + len(b))
			return a + b
		}
		if la, ok := l.([]any); ok {
			if ra, ok := r.([]any); ok {
				env.chargeList(len(la) + len(ra))
				return append(append([]any{}, la...), ra...)
			}
		}
	}
	if l == nil || r == nil {
		return nil // arithmetic on a missing property stays missing
	}
	fail("cannot apply %q to %s and %s", op, KindOf(l), KindOf(r))
	return nil
}

func toDuration(v any) (Duration, bool) {
	switch t := v.(type) {
	case Duration:
		return t, true
	case string:
		return ParseDuration(t)
	}
	return Duration{}, false
}

func (env *Env) call(c *callExpr) any {
	switch fn := c.fn.(type) {
	case ident:
		return env.callGlobal(string(fn), c.args)
	case *member:
		recv := env.eval(fn.obj)
		return env.callMethod(recv, fn.name, c.args)
	}
	fail("this expression is not callable")
	return nil
}

func (env *Env) args(args []Expr) []any {
	out := make([]any, len(args))
	for i, a := range args {
		out[i] = env.eval(a)
	}
	return out
}

func want(name string, args []Expr, min, max int) {
	if len(args) < min || len(args) > max {
		if min == max {
			fail("%s() takes %d argument(s), got %d", name, min, len(args))
		}
		fail("%s() takes %d to %d arguments, got %d", name, min, max, len(args))
	}
}

func (env *Env) today() Date {
	n := env.Now
	return Date{T: time.Date(n.Year(), n.Month(), n.Day(), 0, 0, 0, 0, n.Location())}
}

func (env *Env) callGlobal(name string, a []Expr) any {
	switch name {
	case "if":
		want(name, a, 2, 3)
		if Truthy(env.eval(a[0])) {
			return env.eval(a[1])
		}
		if len(a) == 3 {
			return env.eval(a[2])
		}
		return nil
	case "now":
		want(name, a, 0, 0)
		return Date{T: env.Now, HasTime: true}
	case "today":
		want(name, a, 0, 0)
		return env.today()
	case "date":
		want(name, a, 1, 1)
		switch v := env.eval(a[0]).(type) {
		case Date:
			return v
		case string:
			if d, ok := ParseDate(v); ok {
				return d
			}
			fail("date(): %q is not a valid date", v)
		case nil:
			return nil
		default:
			fail("date(): cannot convert %s", KindOf(v))
		}
	case "number":
		want(name, a, 1, 1)
		return toNumber(env.eval(a[0]))
	case "link":
		want(name, a, 1, 2)
		args := env.args(a)
		l := Link{Target: env.str(args[0])}
		if len(args) == 2 {
			l.Display = env.str(args[1])
		}
		return l
	case "list":
		want(name, a, 1, 1)
		v := env.eval(a[0])
		if l, ok := v.([]any); ok {
			return l
		}
		if v == nil {
			return []any{}
		}
		return []any{v}
	case "concat":
		args := env.args(a)
		parts := make([]string, len(args))
		size := 0
		for i, v := range args {
			parts[i] = env.str(v)
			size += len(parts[i])
		}
		env.charge(size)
		return strings.Join(parts, "")
	case "min", "max":
		if len(a) == 0 {
			fail("%s() needs at least one argument", name)
		}
		return env.extreme(name, env.args(a))
	case "abs", "round", "floor", "ceil":
		want(name, a, 1, 2)
		args := env.args(a)
		return numMethod(name, toNumber(args[0]), args[1:])
	case "duration":
		want(name, a, 1, 1)
		s := env.str(env.eval(a[0]))
		d, ok := ParseDuration(s)
		if !ok {
			fail("duration(): %q is not a valid duration", s)
		}
		return d
	}
	fail("unknown function %q", name)
	return nil
}

func toNumber(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case bool:
		return b2f(t)
	case string:
		var f float64
		if _, err := fmt.Sscanf(strings.TrimSpace(t), "%g", &f); err != nil {
			fail("%q is not a number", t)
		}
		return f
	case Date:
		return float64(t.T.UnixMilli())
	}
	fail("cannot convert %s to a number", KindOf(v))
	return 0
}

func (env *Env) extreme(name string, vals []any) any {
	if len(vals) == 1 {
		if l, ok := vals[0].([]any); ok {
			vals = l
		}
	}
	var best any
	for _, v := range vals {
		env.tick(1)
		if v == nil {
			continue
		}
		env.scanValue(v)
		if best == nil {
			best = v
			continue
		}
		c, ok := Compare(v, best)
		if !ok {
			fail("%s(): values are not comparable", name)
		}
		if (name == "min" && c < 0) || (name == "max" && c > 0) {
			best = v
		}
	}
	return best
}

func numMethod(name string, n float64, rest []any) any {
	switch name {
	case "abs":
		return math.Abs(n)
	case "floor":
		return math.Floor(n)
	case "ceil":
		return math.Ceil(n)
	case "round", "toFixed":
		digits := 0.0
		if len(rest) > 0 {
			digits = toNumber(rest[0])
		}
		p := math.Pow(10, digits)
		return math.Round(n*p) / p
	}
	fail("unknown number method %q", name)
	return nil
}

func (env *Env) callMethod(recv any, name string, a []Expr) any {
	if f, ok := recv.(fileObj); ok {
		return env.fileMethod(f.n, name, a)
	}
	switch name {
	case "isEmpty":
		want(name, a, 0, 0)
		switch t := recv.(type) {
		case nil:
			return true
		case string:
			return t == ""
		case []any:
			return len(t) == 0
		}
		return false
	case "toString":
		want(name, a, 0, 0)
		return env.str(recv)
	case "isTruthy":
		return Truthy(recv)
	}
	if recv == nil {
		return nil // methods on a missing property yield a missing value
	}
	switch t := recv.(type) {
	case string:
		return env.stringMethod(t, name, a)
	case []any:
		return env.listMethod(t, name, a)
	case float64:
		want(name, a, 0, 1)
		return numMethod(name, t, env.args(a))
	case Date:
		return env.dateMethod(t, name, a)
	case Link:
		if name == "toString" {
			return env.str(t)
		}
	}
	fail("%s has no method %q", KindOf(recv), name)
	return nil
}

func (env *Env) fileMethod(n *Note, name string, a []Expr) any {
	args := env.args(a)
	switch name {
	case "hasTag":
		for _, want := range args {
			w := strings.TrimPrefix(env.str(want), "#")
			for _, t := range n.Tags {
				t = strings.TrimPrefix(t, "#")
				if strings.EqualFold(t, w) || strings.HasPrefix(strings.ToLower(t), strings.ToLower(w)+"/") {
					return true
				}
			}
		}
		return false
	case "inFolder":
		if len(args) != 1 {
			fail("inFolder() takes 1 argument")
		}
		f := strings.Trim(env.str(args[0]), "/")
		return f == "" || n.folder == f || strings.HasPrefix(n.folder, f+"/")
	case "hasLink":
		if len(args) != 1 {
			fail("hasLink() takes 1 argument")
		}
		w := env.str(args[0])
		w = strings.TrimSuffix(strings.TrimSuffix(strings.TrimPrefix(w, "[["), "]]"), ".md")
		for _, l := range n.Links {
			if strings.TrimSuffix(l, ".md") == w || strings.TrimSuffix(path.Base(l), ".md") == w {
				return true
			}
		}
		return false
	case "hasProperty":
		if len(args) != 1 {
			fail("hasProperty() takes 1 argument")
		}
		_, ok := n.Prop(env.str(args[0]))
		return ok
	}
	fail("file has no method %q", name)
	return nil
}

func (env *Env) stringMethod(s, name string, a []Expr) any {
	switch name {
	case "contains", "startsWith", "endsWith":
		want(name, a, 1, 1)
		x := env.str(env.eval(a[0]))
		env.scan(len(s))
		switch name {
		case "contains":
			return strings.Contains(s, x)
		case "startsWith":
			return strings.HasPrefix(s, x)
		}
		return strings.HasSuffix(s, x)
	case "lower":
		env.charge(caseBytes(s))
		return strings.ToLower(s)
	case "upper":
		env.charge(caseBytes(s))
		return strings.ToUpper(s)
	case "trim":
		env.scan(len(s))
		return strings.TrimSpace(s)
	case "title":
		env.charge(caseBytes(s)) // the lower-case copy
		env.charge(caseBytes(s)) // the result
		words := strings.Fields(strings.ToLower(s))
		for i, w := range words {
			r, size := utf8.DecodeRuneInString(w) // the first rune, not the first byte
			words[i] = string(unicode.ToTitle(r)) + w[size:]
		}
		return strings.Join(words, " ")
	case "reverse":
		env.charge(len(s))
		rs := []rune(s)
		for i, j := 0, len(rs)-1; i < j; i, j = i+1, j-1 {
			rs[i], rs[j] = rs[j], rs[i]
		}
		return string(rs)
	case "repeat":
		want(name, a, 1, 1)
		f := math.Trunc(toNumber(env.eval(a[0])))
		// Checked as a float: a huge count must neither wrap around once
		// multiplied nor overflow the conversion to int.
		if !(f >= 0) || (len(s) > 0 && f > float64(100_000/len(s))) {
			fail("repeat(): count out of range")
		}
		if s == "" {
			return ""
		}
		n := int(f)
		env.charge(n * len(s))
		return strings.Repeat(s, n)
	case "replace":
		want(name, a, 2, 2)
		args := env.args(a)
		old, repl := env.str(args[0]), env.str(args[1])
		env.scan(len(s))
		// The size of the result is paid before building it: an empty old
		// text matches before every rune and at the end.
		if hits := strings.Count(s, old); hits > 0 {
			if grow := len(repl) - len(old); grow > 0 && hits > maxValueBytes/grow {
				env.charge(maxValueBytes + 1)
			}
			env.charge(len(s) + hits*(len(repl)-len(old)))
		}
		return strings.ReplaceAll(s, old, repl)
	case "split":
		want(name, a, 1, 2)
		args := env.args(a)
		sep := env.str(args[0])
		env.scan(len(s))
		if sep == "" {
			env.chargeList(utf8.RuneCountInString(s))
		} else {
			env.chargeList(strings.Count(s, sep) + 1)
		}
		parts := strings.Split(s, sep)
		out := make([]any, len(parts))
		for i, p := range parts {
			out[i] = p
		}
		return out
	case "slice":
		want(name, a, 1, 2)
		args := env.args(a)
		env.scan(len(s))
		from, to := clampRange(utf8.RuneCountInString(s), args)
		return s[runeOffset(s, from):runeOffset(s, to)] // shares the text: nothing to charge
	}
	fail("text has no method %q", name)
	return nil
}

// caseBytes bounds the size of s after a case mapping, which may turn a rune
// into a longer UTF-8 sequence.
func caseBytes(s string) int { return len(s) + len(s)/2 }

// runeOffset is the byte offset of the rune at index i of s (len(s) past the end).
func runeOffset(s string, i int) int {
	for off := range s {
		if i == 0 {
			return off
		}
		i--
	}
	return len(s)
}

func clampRange(n int, args []any) (int, int) {
	from, to := 0, n
	if len(args) > 0 {
		from = int(toNumber(args[0]))
	}
	if len(args) > 1 && args[1] != nil {
		to = int(toNumber(args[1]))
	}
	if from < 0 {
		from += n
	}
	if to < 0 {
		to += n
	}
	from = max(0, min(from, n))
	to = max(from, min(to, n))
	return from, to
}

func (env *Env) withLocals(value any, index int, e Expr) any {
	saved := env.locals
	env.locals = map[string]any{"value": value, "index": float64(index)}
	defer func() { env.locals = saved }()
	return env.eval(e)
}

func (env *Env) listMethod(l []any, name string, a []Expr) any {
	switch name {
	case "contains":
		want(name, a, 1, 1)
		x := env.eval(a[0])
		for _, e := range l {
			if env.equal(e, x) {
				return true
			}
		}
		return false
	case "containsAll", "containsAny":
		args := env.args(a)
		hits := 0
		for _, w := range args {
			for _, e := range l {
				if env.equal(e, w) {
					hits++
					break
				}
			}
		}
		if name == "containsAll" {
			return hits == len(args)
		}
		return hits > 0
	case "join":
		want(name, a, 0, 1)
		sep := ", "
		if len(a) == 1 {
			sep = env.str(env.eval(a[0]))
		}
		parts := make([]string, len(l))
		size := 0
		for i, e := range l {
			parts[i] = env.str(e)
			if size += len(parts[i]); size > maxValueBytes {
				env.charge(size)
			}
		}
		if len(l) > 1 {
			if len(sep) > maxValueBytes/(len(l)-1) {
				env.charge(maxValueBytes + 1)
			}
			size += (len(l) - 1) * len(sep)
		}
		env.charge(size)
		return strings.Join(parts, sep)
	case "map", "filter":
		want(name, a, 1, 1)
		env.chargeList(len(l))
		out := make([]any, 0, len(l))
		for i, e := range l {
			r := env.withLocals(e, i, a[0])
			if name == "map" {
				out = append(out, r)
			} else if Truthy(r) {
				out = append(out, e)
			}
		}
		return out
	case "sum", "count", "mean", "average":
		want(name, a, 0, 0)
		env.tick(len(l))
		return aggregate(name, l)
	case "min", "max":
		return env.extreme(name, []any{l})
	case "unique":
		return env.unique(l)
	case "sort":
		env.chargeList(len(l))
		out := append([]any{}, l...)
		sort.SliceStable(out, func(i, j int) bool {
			env.tick(1)
			env.scanValue(out[i])
			env.scanValue(out[j])
			return SortCompare(out[i], out[j]) < 0
		})
		return out
	case "reverse":
		env.chargeList(len(l))
		out := make([]any, len(l))
		for i, e := range l {
			out[len(l)-1-i] = e
		}
		return out
	case "flat":
		n := 0
		for _, e := range l {
			if s, ok := e.([]any); ok {
				n += len(s)
			} else {
				n++
			}
		}
		env.chargeList(n)
		out := make([]any, 0, n)
		for _, e := range l {
			if s, ok := e.([]any); ok {
				out = append(out, s...)
			} else {
				out = append(out, e)
			}
		}
		return out
	case "slice":
		from, to := clampRange(len(l), env.args(a))
		env.chargeList(to - from)
		return append([]any{}, l[from:to]...)
	case "concat":
		args := env.args(a)
		n := len(l)
		for _, v := range args {
			if s, ok := v.([]any); ok {
				n += len(s)
			} else {
				n++
			}
		}
		env.chargeList(n)
		out := append(make([]any, 0, n), l...)
		for _, v := range args {
			if s, ok := v.([]any); ok {
				out = append(out, s...)
			} else {
				out = append(out, v)
			}
		}
		return out
	}
	fail("list has no method %q", name)
	return nil
}

// unique keeps the first item of each group of equal items. Lists of plain
// values (for which Equal is ==: texts, numbers, booleans, durations) use a set;
// the others compare each item with the kept ones, one step per comparison.
func (env *Env) unique(l []any) any {
	env.chargeList(len(l))
	out := []any{}
	plain := true
	for _, e := range l {
		switch e.(type) {
		case nil, bool, float64, string, Duration:
		default:
			plain = false // Equal differs from == (dates, links, lists, objects)
		}
	}
	if plain {
		env.tick(len(l))
		seen := make(map[any]bool, len(l))
		for _, e := range l {
			if !seen[e] {
				seen[e] = true
				out = append(out, e)
			}
		}
		return out
	}
	for _, e := range l {
		dup := false
		for _, o := range out {
			if env.equal(o, e) {
				dup = true
				break
			}
		}
		if !dup {
			out = append(out, e)
		}
	}
	return out
}

func aggregate(name string, l []any) any {
	if name == "count" {
		return float64(len(l))
	}
	sum, n := 0.0, 0
	for _, e := range l {
		if e == nil {
			continue
		}
		f, ok := e.(float64)
		if !ok {
			fail("%s(): %s is not a number", name, KindOf(e))
		}
		sum += f
		n++
	}
	if name == "sum" {
		return sum
	}
	if n == 0 {
		return nil
	}
	return sum / float64(n)
}

func (env *Env) dateMethod(d Date, name string, a []Expr) any {
	switch name {
	case "format":
		want(name, a, 1, 1)
		layout := env.str(env.eval(a[0]))
		env.scan(len(layout))
		out := FormatDate(d, layout)
		env.charge(len(out)) // a few times the layout at most
		return out
	case "date":
		return Date{T: time.Date(d.T.Year(), d.T.Month(), d.T.Day(), 0, 0, 0, 0, d.T.Location())}
	case "time":
		return FormatDate(d, "HH:mm:ss")
	case "relative":
		return relative(d.T, env.Now)
	}
	fail("date has no method %q", name)
	return nil
}

func relative(t, now time.Time) string {
	diff := t.Sub(now)
	abs := diff
	if abs < 0 {
		abs = -abs
	}
	unit, n := "second", int(abs.Seconds())
	switch {
	case abs >= 24*time.Hour:
		unit, n = "day", int(abs.Hours()/24)
	case abs >= time.Hour:
		unit, n = "hour", int(abs.Hours())
	case abs >= time.Minute:
		unit, n = "minute", int(abs.Minutes())
	}
	if n != 1 {
		unit += "s"
	}
	if diff < 0 {
		return fmt.Sprintf("%d %s ago", n, unit)
	}
	return fmt.Sprintf("in %d %s", n, unit)
}
