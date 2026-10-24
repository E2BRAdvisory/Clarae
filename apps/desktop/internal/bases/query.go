package bases

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
)

// Cell is a typed value for the UI. V is JSON-friendly; E is set for errors.
type Cell struct {
	K string `json:"k"`
	V any    `json:"v,omitempty"`
	E string `json:"e,omitempty"`
}

// Column describes a displayed column.
type Column struct {
	ID       string `json:"id"`   // as written in the view order
	Key      string `json:"key"`  // frontmatter key for note properties, else ""
	Name     string `json:"name"` // display name
	Kind     string `json:"kind"`
	Editable bool   `json:"editable"` // a note property: the UI may edit it inline
	Formula  bool   `json:"formula"`
}

// Row is one result row.
type Row struct {
	Path  string `json:"path"`
	Hash  string `json:"hash"`
	Cells []Cell `json:"cells"`
}

// Group is a contiguous range of Rows sharing a groupBy value.
type Group struct {
	Key   Cell `json:"key"`
	Start int  `json:"start"`
	Count int  `json:"count"`
}

// Result is the outcome of running a view.
type Result struct {
	View      string   `json:"view"`
	Type      string   `json:"type"`
	Columns   []Column `json:"columns"`
	Rows      []Row    `json:"rows"`
	Groups    []Group  `json:"groups"`
	Total     int      `json:"total"` // rows matching before "limit"
	Summaries []Cell   `json:"summaries"`
	Notices   []string `json:"notices"`
}

// RunOptions tunes a query.
type RunOptions struct {
	This   *Note             // the note embedding the base (for "this"), may be nil
	Now    time.Time         // zero = time.Now()
	Schema map[string]string // declared property types (.nodus/types.json)
}

type rowCtx struct {
	note *Note
	env  *Env
	keys []any // sort keys
	grp  any
}

// Run evaluates a view over notes. Notes are assumed Prepare()d.
func (b *Base) Run(notes []*Note, viewIndex int, opts RunOptions) (*Result, error) {
	if viewIndex < 0 || viewIndex >= len(b.Views) {
		return nil, fmt.Errorf("view %d does not exist", viewIndex)
	}
	v := b.Views[viewIndex]
	res := &Result{View: v.Name, Type: v.Type, Columns: []Column{}, Rows: []Row{}, Groups: []Group{}, Summaries: []Cell{}, Notices: append([]string{}, b.Notices...)}
	if !v.Supported {
		res.Notices = append(res.Notices, v.Notice)
		return res, nil
	}
	now := opts.Now
	if now.IsZero() {
		now = time.Now()
	}

	var rows []*rowCtx
	for _, n := range notes {
		env := NewEnv(n, opts.This, now, b.Formulas)
		if b.Filters.Match(env) && v.Filters.Match(env) {
			rows = append(rows, &rowCtx{note: n, env: env})
		}
	}
	res.Total = len(rows)

	order := v.Order
	if len(order) == 0 {
		order = []string{"file.name"}
	}
	b.sortRows(rows, v)
	if v.Limit > 0 && len(rows) > v.Limit {
		rows = rows[:v.Limit]
	}
	b.group(rows, v, res)

	res.Columns = make([]Column, len(order))
	for i, id := range order {
		res.Columns[i] = b.column(id, opts.Schema)
	}
	res.Rows = make([]Row, len(rows))
	for i, r := range rows {
		cells := make([]Cell, len(order))
		for j, id := range order {
			cells[j] = columnCell(r, id)
		}
		res.Rows[i] = Row{Path: r.note.Path, Hash: r.note.Hash, Cells: cells}
	}
	for j := range res.Columns {
		c := &res.Columns[j]
		if c.Kind == KindNull || c.Kind == "" {
			c.Kind = KindText
			for _, r := range res.Rows {
				if r.Cells[j].K != KindNull && r.Cells[j].K != KindError {
					c.Kind = r.Cells[j].K
					break
				}
			}
		}
	}
	res.Summaries = b.summaries(res, v)
	return res, nil
}

func (b *Base) sortRows(rows []*rowCtx, v View) {
	specs := v.Sort
	for _, r := range rows {
		r.keys = make([]any, len(specs))
		for i, s := range specs {
			r.keys[i] = rawValue(r, s.Property)
		}
		if v.GroupBy != nil {
			r.grp = rawValue(r, v.GroupBy.Property)
		}
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if v.GroupBy != nil {
			c := SortCompare(rows[i].grp, rows[j].grp)
			if v.GroupBy.Direction == "DESC" && rows[i].grp != nil && rows[j].grp != nil {
				c = -c
			}
			if c != 0 {
				return c < 0
			}
		}
		for k, s := range specs {
			a, bb := rows[i].keys[k], rows[j].keys[k]
			c := SortCompare(a, bb)
			if s.Direction == "DESC" && a != nil && bb != nil {
				c = -c
			}
			if c != 0 {
				return c < 0
			}
		}
		return false
	})
}

func (b *Base) group(rows []*rowCtx, v View, res *Result) {
	if v.GroupBy == nil {
		return
	}
	for i, r := range rows {
		if n := len(res.Groups); n > 0 && Equal(rows[res.Groups[n-1].Start].grp, r.grp) {
			res.Groups[n-1].Count++
			continue
		}
		res.Groups = append(res.Groups, Group{Key: toCell(r.grp), Start: i, Count: 1})
	}
}

// rawValue evaluates a column identifier to a raw value (errors become nil).
func rawValue(r *rowCtx, id string) any {
	switch {
	case strings.HasPrefix(id, "file."):
		name := strings.TrimPrefix(id, "file.")
		if !isFileProp(name) {
			return nil
		}
		return fileField(r.note, name)
	case strings.HasPrefix(id, "formula."):
		v, err := r.env.EvalFormula(strings.TrimPrefix(id, "formula."))
		if err != nil {
			return nil
		}
		return v
	}
	return propValue(r.note, strings.TrimPrefix(id, "note."))
}

func isFileProp(name string) bool {
	for _, p := range FileProps {
		if p == name {
			return true
		}
	}
	return false
}

func toCell(v any) Cell {
	if v == nil {
		return Cell{K: KindNull}
	}
	return Cell{K: KindOf(v), V: ToJSON(v)}
}

func columnCell(r *rowCtx, id string) Cell {
	switch {
	case id == "file.name":
		n := r.note
		display := n.name
		if n.ext == "md" {
			display = n.basename()
		}
		return Cell{K: KindLink, V: "[[" + n.Path + "|" + display + "]]"}
	case strings.HasPrefix(id, "file."):
		name := strings.TrimPrefix(id, "file.")
		if !isFileProp(name) {
			return Cell{K: KindError, E: fmt.Sprintf("unknown file property %q", name)}
		}
		return toCell(fileField(r.note, name))
	case strings.HasPrefix(id, "formula."):
		v, err := r.env.EvalFormula(strings.TrimPrefix(id, "formula."))
		if err != nil {
			return Cell{K: KindError, E: err.Error()}
		}
		return toCell(v)
	}
	return toCell(propValue(r.note, strings.TrimPrefix(id, "note.")))
}

var fileKinds = map[string]string{
	"name": KindLink, "basename": KindText, "path": KindText, "folder": KindText, "ext": KindText,
	"size": KindNumber, "ctime": KindDateTime, "mtime": KindDateTime, "tags": KindList, "links": KindList,
}

func (b *Base) column(id string, schema map[string]string) Column {
	c := Column{ID: id}
	switch {
	case strings.HasPrefix(id, "file."):
		name := strings.TrimPrefix(id, "file.")
		c.Name, c.Kind = name, fileKinds[name]
		if name == "name" {
			c.Name = "Name"
		}
	case strings.HasPrefix(id, "formula."):
		c.Name, c.Formula = strings.TrimPrefix(id, "formula."), true
	default:
		c.Key = strings.TrimPrefix(id, "note.")
		c.Name, c.Editable = c.Key, true
		if k, ok := schema[c.Key]; ok {
			c.Kind = k
		}
	}
	if dn, ok := b.DisplayNames[id]; ok {
		c.Name = dn
	} else if dn, ok := b.DisplayNames["note."+id]; ok && c.Key != "" {
		c.Name = dn
	}
	return c
}

// summaries computes the per-column summary row ("summaries" of the view).
func (b *Base) summaries(res *Result, v View) []Cell {
	if len(v.Summaries) == 0 {
		return []Cell{}
	}
	out := make([]Cell, len(res.Columns))
	found := false
	for j, c := range res.Columns {
		name, ok := v.Summaries[c.ID]
		if !ok {
			name, ok = v.Summaries[strings.TrimPrefix(c.ID, "note.")]
		}
		if !ok {
			out[j] = Cell{K: KindNull}
			continue
		}
		found = true
		vals := make([]Value, 0, len(res.Rows))
		for _, r := range res.Rows {
			vals = append(vals, r.Cells[j])
		}
		out[j] = summarize(name, vals)
	}
	if !found {
		return []Cell{}
	}
	return out
}

// Value aliases Cell for summary computation (cells carry JSON-friendly values).
type Value = Cell

func summarize(name string, cells []Value) Cell {
	var nums []float64
	var present []Cell
	for _, c := range cells {
		if c.K == KindNull || c.K == KindError {
			continue
		}
		present = append(present, c)
		if f, ok := c.V.(float64); ok && (c.K == KindNumber || c.K == KindDuration) {
			nums = append(nums, f)
		}
	}
	num := func(f float64) Cell { return Cell{K: KindNumber, V: f} }
	switch strings.ToLower(name) {
	case "count":
		return num(float64(len(cells)))
	case "empty":
		return num(float64(len(cells) - len(present)))
	case "filled":
		return num(float64(len(present)))
	case "unique":
		seen := map[string]bool{}
		for _, c := range present {
			seen[fmt.Sprint(c.V)] = true
		}
		return num(float64(len(seen)))
	case "sum", "average", "avg", "min", "max", "median", "range":
		if len(nums) == 0 {
			return Cell{K: KindNull}
		}
		sort.Float64s(nums)
		sum := 0.0
		for _, n := range nums {
			sum += n
		}
		switch strings.ToLower(name) {
		case "sum":
			return num(sum)
		case "average", "avg":
			return num(sum / float64(len(nums)))
		case "min":
			return num(nums[0])
		case "max":
			return num(nums[len(nums)-1])
		case "range":
			return num(nums[len(nums)-1] - nums[0])
		}
		mid := len(nums) / 2
		if len(nums)%2 == 1 {
			return num(nums[mid])
		}
		return num(math.Round((nums[mid-1]+nums[mid])/2*1e9) / 1e9)
	case "earliest", "latest":
		var best *Cell
		for i := range present {
			c := &present[i]
			if c.K != KindDate && c.K != KindDateTime {
				continue
			}
			if best == nil || (strings.EqualFold(name, "earliest") && fmt.Sprint(c.V) < fmt.Sprint(best.V)) ||
				(strings.EqualFold(name, "latest") && fmt.Sprint(c.V) > fmt.Sprint(best.V)) {
				best = c
			}
		}
		if best == nil {
			return Cell{K: KindNull}
		}
		return *best
	}
	return Cell{K: KindError, E: fmt.Sprintf("summary %q is not supported", name)}
}
