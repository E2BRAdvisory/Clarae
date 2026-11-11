package bases

import (
	"context"
	"errors"
	"fmt"
	"runtime/debug"
)

// Limits of the evaluation. A .base file may come from a shared vault, so its
// expressions are untrusted: they must not be able to exhaust the CPU or the
// memory of the process (running out of memory is fatal in Go). Exceeding a
// limit is an evaluation error, so it becomes a cell error.
const (
	maxSteps      = 200_000   // nodes evaluated by one expression or formula
	maxValueBytes = 1 << 20   // size of one string or list an expression produces
	maxRowBytes   = 16 << 20  // bytes produced for one row, cached formula values included
	maxRunBytes   = 256 << 20 // bytes produced by a whole Run
	itemBytes     = 32        // estimated cost of a list item (interface and boxed value)
	ctxCheckSteps = 4096      // steps between two checks of the run's context
)

// maxRunSteps bounds the steps of a whole Run: all rows, filters, sort keys
// and columns. A variable only so that tests can reach it quickly.
var maxRunSteps = 50_000_000

// runBudget is shared by the environments of one Run, so that the cost of a
// base is bounded as a whole and not per row or per formula.
type runBudget struct {
	ctx       context.Context
	steps     int
	bytes     int
	exhausted bool  // a run-wide limit was hit: some cells or rows are missing
	cancelled error // the context was done during an evaluation
	onPanic   func(error)
	panicked  bool
}

func newRunBudget(ctx context.Context, onPanic func(error)) *runBudget {
	if ctx == nil {
		ctx = context.Background()
	}
	return &runBudget{ctx: ctx, onPanic: onPanic}
}

// PanicError is an unexpected failure (a bug) of the evaluator. It is
// recovered so that it can neither take the process down nor leave a binding
// call without an answer (Wails v2 never resolved the promise after a panic; v3 rejects it).
type PanicError struct {
	Value any
	Stack []byte
}

func (e *PanicError) Error() string { return fmt.Sprintf("internal error: %v", e.Value) }

// report hands the first unexpected failure of a run to the log.
func (r *runBudget) report(err error) {
	if r.onPanic != nil && !r.panicked {
		r.panicked = true
		r.onPanic(err)
	}
}

// recoverEval turns a panic of the evaluator into the error of Eval or
// EvalFormula; it must be deferred directly.
func (env *Env) recoverEval(v *any, err *error) {
	r := recover()
	if r == nil {
		return
	}
	*v = nil
	if ee, ok := r.(evalError); ok {
		*err = errors.New(ee.msg)
		return
	}
	pe := &PanicError{Value: r, Stack: debug.Stack()}
	*err = pe
	env.budget().report(pe)
}

func (env *Env) budget() *runBudget {
	if env.run == nil {
		env.run = newRunBudget(context.Background(), nil)
	}
	return env.run
}

// tick spends n steps of the expression and of the run, and checks from time
// to time whether the run was cancelled.
func (env *Env) tick(n int) {
	env.steps += n
	if env.steps > maxSteps {
		fail("expression is too expensive to evaluate")
	}
	r := env.budget()
	if !r.spend(n) {
		return
	}
	if r.cancelled != nil {
		fail("evaluation cancelled")
	}
	fail("the base is too expensive to evaluate")
}

// spend takes n steps from the run outside of an evaluation too (sorting the
// rows): it reports whether the run must stop, because its steps are spent or
// its context is done.
func (r *runBudget) spend(n int) bool {
	if r.cancelled != nil {
		return true
	}
	before := r.steps
	r.steps += n
	if r.steps > maxRunSteps {
		r.exhausted = true
		return true
	}
	if before/ctxCheckSteps != r.steps/ctxCheckSteps {
		if err := r.ctx.Err(); err != nil {
			r.cancelled = err
			return true
		}
	}
	return false
}

// scan pays for reading n bytes of existing text (one step per KiB).
func (env *Env) scan(n int) { env.tick(n >> 10) }

// charge pays for a string or list of n bytes before it is built.
func (env *Env) charge(n int) {
	env.chargeValue(n)
	env.bytes += n
	if env.bytes > maxRowBytes {
		fail("expression uses too much memory")
	}
	env.chargeRun(n)
}

func (env *Env) chargeValue(n int) {
	if n < 0 || n > maxValueBytes {
		fail("value is too large (more than %d bytes)", maxValueBytes)
	}
	env.scan(n)
}

func (env *Env) chargeRun(n int) {
	r := env.budget()
	r.bytes += n
	if r.bytes > maxRunBytes {
		r.exhausted = true
		fail("the base uses too much memory")
	}
}

// output pays for the text a value becomes once handed to the UI: a list may
// reference the same long text many times, each copy free inside the
// evaluator but not once encoded. It returns the error of the cell. The
// output counts for the run only, so that a row that spent its own memory
// still shows its cheap cells.
func (env *Env) output(v any) (err error) {
	defer env.recoverEval(new(any), &err)
	env.steps = 0
	n := 0
	switch t := v.(type) {
	case string:
		n = len(t)
	case []any:
		n = strSize(t, maxValueBytes+1) + len(t)*itemBytes
	}
	if n == 0 {
		return nil
	}
	env.chargeValue(n)
	env.chargeRun(n)
	return nil
}

// chargeList pays for a list of n items.
func (env *Env) chargeList(n int) {
	if n < 0 || n > maxValueBytes/itemBytes {
		fail("list is too long (more than %d items)", maxValueBytes/itemBytes)
	}
	env.charge(n * itemBytes)
}

// str is Str with the text of a list paid for first: it may be much larger
// than the list itself (the same long item referenced many times).
func (env *Env) str(v any) string {
	if l, ok := v.([]any); ok {
		env.charge(strSize(l, maxValueBytes+1))
	}
	return Str(v)
}

// strSize is len(Str(l)), computed without building the text; it stops as
// soon as the size exceeds limit.
func strSize(l []any, limit int) int {
	n := 0
	for i, e := range l {
		if i > 0 {
			n += 2 // ", "
		}
		if s, ok := e.([]any); ok {
			n += strSize(s, limit-n)
		} else {
			n += len(Str(e))
		}
		if n > limit {
			return n
		}
	}
	return n
}

// equal is Equal paying one step per value compared (lists compare item by item).
func (env *Env) equal(a, b any) bool {
	env.tick(1)
	x, xl := a.([]any)
	y, yl := b.([]any)
	if xl && yl {
		if len(x) != len(y) {
			return false
		}
		for i := range x {
			if !env.equal(x[i], y[i]) {
				return false
			}
		}
		return true
	}
	return Equal(a, b)
}

// scanValue pays for comparing v when it is a long text.
func (env *Env) scanValue(v any) {
	if s, ok := v.(string); ok {
		env.scan(len(s))
	}
}
